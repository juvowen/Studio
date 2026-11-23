"""Live Vogue Runway lookups for the Runway page.

Runs the Vogue Runway Scraper (https://github.com/TonyAssi/Vogue-Runway-Scraper,
copied in ./Vogue-Runway-Scraper) only when someone picks a brand or a show.
Nothing is downloaded ahead of time; pictures load straight from Vogue.

  python server.py            # http://localhost:8000

  GET /api/designers                      every brand the scraper knows
  GET /api/shows?designer=OFF-WHITE       that brand's shows, newest first
  GET /api/show?designer=OFF-WHITE&show=Fall 2020 Ready-to-Wear
                                          picture addresses for one show
  GET /api/art/artists                    Art Studio artists (Art Institute of Chicago)
  GET /api/art/periods                    Art Studio periods with work counts
  GET /api/art/event-types                NYC art event types with counts (NYC Parks)
  GET /api/art/events?type=exhibitions    NYC art events of one type, or type=all
                                          (gallery shows come from galleries.py)
  GET /api/art/events/status              when galleries were last read, and how each went
  GET /api/art/works?artist=35809&page=1  one page of an artist's works
  GET /api/art/works?period=baroque       ...or of a period's works
  GET /api/art/image/<image id>           one artwork picture, fetched from the museum
                                          (?size=large for the bigger view)

It also serves the built site (Frontend/dist) when it exists, so after
`npm run build` the whole site runs from this one command.
"""
import functools
import json
import os
import re
import socket
import sys
import threading
import time
from datetime import datetime
from html import unescape
from zoneinfo import ZoneInfo
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

import galleries

HERE = Path(__file__).resolve().parent
SCRAPER = HERE / "Vogue-Runway-Scraper"
DIST = HERE.parent / "Frontend" / "dist"
PORT = int(os.environ.get("PORT", 8000))
DEFAULT = ("OFF-WHITE", "Fall 2020 Ready-to-Wear")  # what the Runway page opens on

from unidecode import unidecode


def year_of(show):
    match = re.search(r"\b(19|20)\d\d\b", show)
    return int(match.group()) if match else None


# designers50.txt names that appear differently in designers.txt.
POPULAR_ALIASES = {
    "CALVIN KLEIN": "CALVIN KLEIN COLLECTION",
    "SALVATORE FERRAGAMO": "FERRAGAMO",
    "MICHAEL KORS": "MICHAEL KORS COLLECTION",
}


def read_names(filename):
    lines = (SCRAPER / filename).read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip()]


@functools.lru_cache(maxsize=1)
def designers():
    """Every brand A-Z, plus the well-known houses to list first."""
    every = sorted(set(read_names("designers.txt")), key=str.casefold)
    known = set(every)
    popular = {DEFAULT[0]}
    for name in read_names("designers50.txt"):
        name = POPULAR_ALIASES.get(name.upper(), name.upper())
        if name in known:
            popular.add(name)
    return {"popular": sorted(popular, key=str.casefold), "all": every}


def remember(lookup):
    """Cache answers that found something; retry empty ones next time."""
    found = {}

    @functools.wraps(lookup)
    def cached(*key):
        if key not in found:
            result = lookup(*key)
            if not result:
                return result
            found[key] = result
        return found[key]

    return cached


# ---- Vogue pages ----------------------------------------------------------------
# Same addresses the scraper builds, but read faster: one kept-alive connection,
# and the page's embedded JSON is decoded straight from the text instead of
# parsing the whole multi-megabyte page with html5lib first.
vogue_session = requests.Session()
STATE_MARK = "window.__PRELOADED_STATE__"


def slug(text):
    return unidecode(text.replace(" ", "-").replace(".", "-").replace("&", "").replace("+", "").replace("--", "-").lower())


def vogue_state(path):
    response = vogue_session.get(f"https://www.vogue.com/fashion-shows/{path}", timeout=20)
    text = response.text
    at = text.find(STATE_MARK)
    if at < 0:
        return {}
    state, _ = json.JSONDecoder().raw_decode(text, text.index("{", at))
    return state.get("transformed", {})


# Answers are also kept on disk, so a restart (or Render waking up) is not cold.
RUNWAY_CACHE = HERE / "cache" / "runway.json"
runway_lock = threading.Lock()
try:
    runway_saved = json.loads(RUNWAY_CACHE.read_text(encoding="utf-8"))
except (OSError, ValueError):
    runway_saved = {}


def saved_lookup(kind):
    def wrap(lookup):
        @functools.wraps(lookup)
        def cached(*key):
            name = "\n".join((kind, *key))
            if name in runway_saved:
                return runway_saved[name]
            result = lookup(*key)
            if result:  # empty answers are retried next time
                with runway_lock:
                    runway_saved[name] = result
                    try:
                        RUNWAY_CACHE.parent.mkdir(exist_ok=True)
                        temporary = RUNWAY_CACHE.with_suffix(".tmp")
                        temporary.write_text(json.dumps(runway_saved), encoding="utf-8")
                        temporary.replace(RUNWAY_CACHE)
                    except OSError as error:
                        print(f"Runway cache not saved: {error}")
            return result

        return cached

    return wrap


@saved_lookup("shows")
def shows(designer):
    collections = vogue_state(f"designer/{slug(designer)}").get("runwayDesignerContent", {}).get("designerCollections", [])
    return [{"show": item["hed"], "year": year_of(item["hed"])} for item in collections if item.get("hed")]


@saved_lookup("show")
def show_images(designer, show):
    galleries = vogue_state(f"{unidecode(show.replace(' ', '-').lower())}/{slug(designer)}").get("runwayShowGalleries", {}).get("galleries") or [{}]
    images = []
    for item in galleries[0].get("items", []):
        try:
            images.append(item["image"]["sources"]["md"]["url"])
        except (KeyError, TypeError):
            pass
    return images


# ---- Art Studio: the Art Institute of Chicago's public API -------------------
# https://api.artic.edu/docs/ — free, no key. Its Cloudflare protection turns
# away some browsers, so the page asks this server, which identifies itself as
# the API's docs request. Only public-domain works with images are used.
ART_API = "https://api.artic.edu/api/v1"
ART_HEADERS = {"User-Agent": "Studio/1.0 (personal art page)", "AIC-User-Agent": "Studio art page"}
ART_TYPES = [1, 14, 18]  # Painting, Drawing and Watercolor, Print
ART_MIN_WORKS = 8  # artists with fewer works are left out of the menu
ART_PAGE = 48
ART_FILTER = [
    {"terms": {"artwork_type_id": ART_TYPES}},
    {"term": {"is_public_domain": True}},
    {"exists": {"field": "image_id"}},
]
# Periods are matched on the year a work was begun (date_start).
ART_PERIODS = [
    {"id": "medieval", "name": "Medieval Period", "start": 500, "end": 1400},
    {"id": "renaissance", "name": "Renaissance & Mannerism", "start": 1400, "end": 1600},
    {"id": "baroque", "name": "Baroque to Neoclassicism", "start": 1600, "end": 1800},
    {"id": "romanticism", "name": "Romanticism & Realism", "start": 1800, "end": 1860},
    {"id": "impressionism", "name": "Impressionism & Post-Impressionism", "start": 1860, "end": 1900},
    {"id": "modern", "name": "Early Modern", "start": 1900, "end": None},
]
ART_PERIOD_IDS = {period["id"]: period for period in ART_PERIODS}
# These are European art-history periods, so works from the museum's Asian and
# African departments are left out of them (they are still listed by artist),
# and so is pre-Columbian art, which the Americas department holds before 1600.
ART_PERIOD_EXCLUDE = [
    {"terms": {"department_title.keyword": ["Arts of Asia", "Arts of Africa"]}},
    {
        "bool": {
            "filter": [
                {"term": {"department_title.keyword": "Arts of the Americas"}},
                {"range": {"date_start": {"lt": 1600}}},
            ]
        }
    },
]


def period_filter(period):
    years = {"gte": period["start"]}
    if period["end"]:
        years["lt"] = period["end"]
    return {"range": {"date_start": years}}


art_session = requests.Session()
art_session.headers.update(ART_HEADERS)


def art_get(path, **params):
    response = art_session.get(f"{ART_API}/{path}", params=params, timeout=20)
    response.raise_for_status()
    return response.json()


def art_search(body, **params):
    return art_get("artworks/search", params=json.dumps(body), **params)


@remember
def art_artists():
    counts = art_search(
        {
            "query": {"bool": {"filter": ART_FILTER}},
            "aggregations": {
                "artists": {"terms": {"field": "artist_id", "size": 400, "min_doc_count": ART_MIN_WORKS}}
            },
        },
        limit=0,
    )
    works = {bucket["key"]: bucket["doc_count"] for bucket in counts["aggregations"]["artists"]["buckets"]}
    ids = list(works)
    people = []
    for start in range(0, len(ids), 100):
        batch = art_get(
            "agents",
            ids=",".join(map(str, ids[start : start + 100])),
            limit=100,
            fields="id,title,birth_date,death_date,agent_type_id",
        )["data"]
        people += [
            {
                "id": agent["id"],
                "name": agent["title"],
                "born": agent.get("birth_date"),
                "died": agent.get("death_date"),
                "works": works[agent["id"]],
            }
            for agent in batch
            # 7 = an individual; the rest are cultures ("Islamic") or groups.
            if agent.get("agent_type_id") == 7 and not re.search(r"unknown|anonymous", agent["title"], re.I)
        ]
    return sorted(people, key=lambda person: person["name"].casefold())


@remember
def art_periods():
    """The periods with how many works each has."""
    ranges = [
        {"key": p["id"], "from": p["start"], **({"to": p["end"]} if p["end"] else {})} for p in ART_PERIODS
    ]
    result = art_search(
        {
            "query": {"bool": {"filter": ART_FILTER, "must_not": ART_PERIOD_EXCLUDE}},
            "aggregations": {"periods": {"range": {"field": "date_start", "ranges": ranges}}},
        },
        limit=0,
    )
    counts = {bucket["key"]: bucket["doc_count"] for bucket in result["aggregations"]["periods"]["buckets"]}
    return [{**period, "works": counts.get(period["id"], 0)} for period in ART_PERIODS]


@remember
def art_works(kind, value, page):
    """One page of works for an artist id or a period id."""
    if kind == "artist":
        query = {"bool": {"filter": ART_FILTER + [{"term": {"artist_id": value}}]}}
    else:
        query = {
            "bool": {
                "filter": ART_FILTER + [period_filter(ART_PERIOD_IDS[value])],
                "must_not": ART_PERIOD_EXCLUDE,
            }
        }
    result = art_search(
        {
            "query": query,
            "sort": [{"artwork_type_id": "asc"}, {"date_start": "asc"}, {"id": "asc"}],
        },
        page=page,
        limit=ART_PAGE,
        fields="id,title,date_display,medium_display,artwork_type_title,image_id,thumbnail,artist_title",
    )
    works = [
        {
            "id": work["id"],
            "title": work["title"],
            "artist": work.get("artist_title"),
            "date": work.get("date_display"),
            "medium": work.get("medium_display"),
            "type": work.get("artwork_type_title"),
            "image": f"/api/art/image/{work['image_id']}",
            "alt": (work.get("thumbnail") or {}).get("alt_text"),
            "link": f"https://www.artic.edu/artworks/{work['id']}",
        }
        for work in result["data"]
        if work.get("image_id")
    ]
    return {"total": result["pagination"]["total"], "works": works}


ART_IMAGE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def art_image(image_id, large=False):
    """The museum's image server refuses pictures requested from other
    websites, so the page gets them through here. 843px wide is the size the
    museum recommends for lists; the large view asks for 1686px, which the
    museum redirects down to the biggest size it allows for that work."""
    width = 1686 if large else 843
    response = art_session.get(f"https://www.artic.edu/iiif/2/{image_id}/full/{width},/0/default.jpg", timeout=30)
    response.raise_for_status()
    return response.content, response.headers.get("Content-Type", "image/jpeg")


# ---- NYC art events: NYC Parks public events (NYC Open Data) ------------------
# https://data.cityofnewyork.us/d/w3wp-dpdi — the city's feed of Parks events
# for the next 14 days, refreshed daily. Official, free, no key.
PARKS_EVENTS = "https://data.cityofnewyork.us/resource/w3wp-dpdi.json"
PARKS_ART_TAGS = {"Art", "Arts & Crafts", "Arts, Culture & Fun Series"}
BOROUGHS = {"B": "Brooklyn", "M": "Manhattan", "Q": "Queens", "R": "Staten Island", "X": "Bronx"}
NEW_YORK = ZoneInfo("America/New_York")
# Event types, matched on an event's title and tags ("title"), and for
# exhibitions also its description ("about"). An event can have more than one
# type; "all" shows every art event.
EVENT_TYPES = [
    {"id": "exhibitions", "name": "Exhibitions & Installations",
     "title": r"exhibit|installation|gallery|museum|open hours", "about": r"exhibition|installation"},
    {"id": "workshops", "name": "Workshops & Classes",
     "title": r"workshop|class|craft|making|printing|sketch|project|ballet|tots|session|chill|gatherings"},
    {"id": "tours", "name": "Tours & Talks", "title": r"\btours?\b|talk|lecture|walk|celebration|gazing"},
    {"id": "kids", "name": "For Kids & Families",
     "title": r"best for kids|kids|family|families|tots|story time|children"},
]
# One menu entry per museum, e.g. "museum-whitney-museum".
MUSEUM_IDS = {f"museum-{re.sub(r'[^a-z0-9]+', '-', m['name'].lower()).strip('-')}": m["name"] for m in galleries.MUSEUMS}
EVENT_TYPE_IDS = (
    {"all", "galleries", "chelsea", "opening", "discovered", "museums", "museums-opening"}
    | {kind["id"] for kind in EVENT_TYPES}
    | set(MUSEUM_IDS)
)


def refreshed_every(seconds):
    """Cache an answer for a while; retry straight away if it found nothing."""

    def wrap(lookup):
        saved = {}

        @functools.wraps(lookup)
        def cached():
            if saved and time.time() - saved["at"] < seconds:
                return saved["value"]
            value = lookup()
            if value:
                saved.update(value=value, at=time.time())
            return value

        return cached

    return wrap


def plain_text(text):
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", text or ""))).strip()


@refreshed_every(3600)
def nyc_art_events():
    rows = requests.get(
        PARKS_EVENTS,
        params={"$where": "categories like '%Art%'", "$order": "starttime", "$limit": 2000},
        headers={"User-Agent": "Studio/1.0 (personal art page)"},
        timeout=20,
    )
    rows.raise_for_status()
    now = datetime.now(NEW_YORK).replace(tzinfo=None).isoformat()
    events = {}
    for row in rows.json():
        tags = [tag.strip() for tag in row.get("categories", "").split("|") if tag.strip()]
        if not PARKS_ART_TAGS & set(tags) or row.get("endtime", row.get("starttime", "")) < now:
            continue
        # A recurring event is listed once per day; show it once with its dates.
        key = (row.get("title", "").strip(), row.get("location", "").strip())
        when = {"start": row.get("starttime"), "end": row.get("endtime")}
        if key in events:
            events[key]["dates"].append(when)
            continue
        title = f"{row.get('title', '')} | {' | '.join(tags)}".lower()
        about = (row.get("description") or "").lower()
        image = (row.get("image") or {}).get("url")
        events[key] = {
            "id": row.get("guid"),
            "title": plain_text(row.get("title")),
            "description": plain_text(row.get("description")),
            "location": plain_text(row.get("location")),
            "park": plain_text(row.get("parknames")),
            "borough": BOROUGHS.get((row.get("parkids") or "?")[0].upper()),
            "image": image.replace("http://", "https://", 1) if image else None,
            "link": (row.get("link") or {}).get("url", "").replace("http://", "https://", 1),
            "types": [
                kind["id"]
                for kind in EVENT_TYPES
                if re.search(kind["title"], title) or ("about" in kind and re.search(kind["about"], about))
            ],
            "dates": [when],
        }
    return sorted(events.values(), key=lambda event: event["dates"][0]["start"] or "")


def parks_events():
    try:
        return [{**event, "source": "parks"} for event in nyc_art_events()]
    except requests.RequestException:
        return []


def events_of(kind):
    """Gallery and museum shows first (closing soonest), then Google-found events, then Parks."""
    everything = galleries.current_shows()
    shows = [show for show in everything if show.get("kind", "gallery") == "gallery"]
    museums = [show for show in everything if show.get("kind") == "museum"]
    if kind == "museums":
        return museums
    if kind == "museums-opening":
        return [show for show in museums if show["opening"]]
    if kind in MUSEUM_IDS:
        return [show for show in museums if show["venue"] == MUSEUM_IDS[kind]]
    found = galleries.discovered_events()
    parks = parks_events()
    if kind == "all":
        return everything + found + parks
    if kind == "galleries":
        return shows
    if kind == "chelsea":
        return [show for show in shows if show["area"] == "Chelsea"]
    if kind == "opening":
        return [show for show in shows if show["opening"]]
    if kind == "discovered":
        return found
    return [event for event in parks if kind in event["types"]]


def nyc_event_types():
    types = [
        {"id": "all", "name": "All Art Events", "group": ""},
        {"id": "galleries", "name": "Gallery Shows — All NYC", "group": "GALLERIES"},
        {"id": "chelsea", "name": "Chelsea Galleries", "group": "GALLERIES"},
        {"id": "opening", "name": "Opening Soon", "group": "GALLERIES"},
        {"id": "museums", "name": "Museum Exhibitions — All NYC", "group": "MUSEUMS"},
        {"id": "museums-opening", "name": "Museums — Opening Soon", "group": "MUSEUMS"},
    ]
    # Each museum by name, once it has something on (browser-built sites need a key).
    types += [
        {"id": id, "name": name, "group": "MUSEUMS"}
        for id, name in MUSEUM_IDS.items()
        if events_of(id)
    ]
    if galleries.status()["serpapi"]:
        types.append({"id": "discovered", "name": "Found on Google Events", "group": "DISCOVERED"})
    types += [{"id": kind["id"], "name": kind["name"], "group": "NYC PARKS"} for kind in EVENT_TYPES]
    return [{**kind, "events": len(events_of(kind["id"]))} for kind in types]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        query = {key: values[0].strip() for key, values in parse_qs(url.query).items()}
        try:
            if url.path == "/api/designers":
                return self.send_json(designers())
            if url.path == "/api/shows" and query.get("designer"):
                found = shows(query["designer"])
                if not found:
                    return self.send_json({"error": "No shows found for this brand."}, 404)
                return self.send_json(found)
            if url.path == "/api/show" and query.get("designer") and query.get("show"):
                images = show_images(query["designer"], query["show"])
                if not images:
                    return self.send_json({"error": "No pictures found for this show."}, 404)
                return self.send_json(images)
            if url.path.startswith("/api/art/image/"):
                image_id = url.path.rsplit("/", 1)[1]
                if not ART_IMAGE_ID.match(image_id):
                    return self.send_json({"error": "Unknown image."}, 404)
                return self.send_image(*art_image(image_id, query.get("size") == "large"))
            if url.path == "/api/art/artists":
                return self.send_json(art_artists())
            if url.path == "/api/art/event-types":
                return self.send_json(nyc_event_types())
            if url.path == "/api/art/events" and query.get("type", "all") in EVENT_TYPE_IDS:
                return self.send_json(events_of(query.get("type", "all")))
            if url.path == "/api/art/events/status":
                return self.send_json(galleries.status())
            if url.path == "/api/art/periods":
                return self.send_json(art_periods())
            if url.path == "/api/art/works":
                page = max(int(query["page"]), 1) if query.get("page", "").isdigit() else 1
                if query.get("artist", "").isdigit():
                    return self.send_json(art_works("artist", int(query["artist"]), page))
                if query.get("period") in ART_PERIOD_IDS:
                    return self.send_json(art_works("period", query["period"], page))
            return self.send_json({"error": "Unknown request."}, 404)
        except Exception as error:
            print(f"Lookup failed for {self.path}: {error}")
            if url.path.startswith("/api/art/event"):
                source = "NYC Parks events"
            elif url.path.startswith("/api/art/"):
                source = "The Art Institute of Chicago"
            else:
                source = "Vogue Runway"
            return self.send_json({"error": f"{source} could not be reached."}, 502)

    def send_image(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # A museum image never changes, so browsers may keep it.
        self.send_header("Cache-Control", "public, max-age=604800, immutable")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    """Answers on both 127.0.0.1 and ::1, whichever `localhost` resolves to."""

    address_family = socket.AF_INET6
    daemon_threads = True

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def warm_up():
    """Look up the opening show now so the first visitor does not wait for Vogue."""
    try:
        shows(DEFAULT[0])
        show_images(*DEFAULT)
        art_artists()
        art_periods()
        nyc_art_events()
    except Exception as error:
        print(f"Warm-up skipped: {error}")


if __name__ == "__main__":
    threading.Thread(target=warm_up, daemon=True).start()
    galleries.start_background_refresh()
    print(f"Studio runway server on http://localhost:{PORT}", flush=True)
    Server(("::", PORT), Handler).serve_forever()
