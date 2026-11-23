"""Current and upcoming New York gallery exhibitions, read from the galleries'
own websites, plus two optional add-ons that need your keys:

  SERPAPI_KEY        Google Events search through SerpApi (serpapi.com), for
                     one-off art events that are not on a gallery list.
  FIRECRAWL_API_KEY  Firecrawl (firecrawl.dev), for gallery sites that build
                     their pages in the browser (Gladstone).

Put them in Backend/.env (see .env.example) or the environment. Without them
the gallery list still works.

Ground rules for reading gallery sites:
  - each site's robots.txt is checked, and a site is skipped if it disallows
    the page or blocks AI crawlers by name (Frieze, Gagosian and Lisson do);
  - requests identify this site honestly, go one at a time per gallery with a
    pause between them, and happen in the background every few hours, never
    when a visitor loads the page;
  - results are kept in Backend/cache/ so a restart does not refetch.
"""
import html as htmllib
import json
import os
import re
import threading
import time
import urllib.robotparser
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import requests

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
NEW_YORK = ZoneInfo("America/New_York")
USER_AGENT = "Studio/1.0 (personal art page)"
REFRESH_HOURS = 6  # gallery sites
DISCOVER_HOURS = 24  # SerpApi searches (free plan: 250 a month)
PAUSE = 0.6  # seconds between requests to the same gallery
UPCOMING_DAYS = 60  # also list shows opening within this many days

# area: neighbourhood of the gallery's New York space(s).
# nyc_only: the gallery has no spaces outside New York, so any show counts;
#   otherwise "New York" must appear next to a show's dates.
# render: the site builds its list in the browser; needs FIRECRAWL_API_KEY.
GALLERIES = [
    {"name": "Almine Rech", "url": "https://www.alminerech.com/exhibitions", "area": "Tribeca"},
    {"name": "Pace", "url": "https://www.pacegallery.com/exhibitions/", "area": "Chelsea"},
    {"name": "David Zwirner", "url": "https://www.davidzwirner.com/exhibitions", "area": "Chelsea"},
    {"name": "Matthew Marks", "url": "https://matthewmarks.com/exhibitions/current", "area": "Chelsea"},
    {"name": "Paula Cooper", "url": "https://www.paulacoopergallery.com/exhibitions", "area": "Chelsea", "nyc_only": True},
    {"name": "Sean Kelly", "url": "https://www.skny.com/exhibitions", "area": "Chelsea"},
    {"name": "Lehmann Maupin", "url": "https://www.lehmannmaupin.com/exhibitions", "area": "Chelsea"},
    {"name": "Marianne Boesky", "url": "https://www.boeskygallery.com/exhibitions", "area": "Chelsea"},
    {"name": "Petzel", "url": "https://www.petzel.com/exhibitions", "area": "Chelsea", "nyc_only": True},
    {"name": "Tanya Bonakdar", "url": "https://www.tanyabonakdargallery.com/exhibitions/", "area": "Chelsea"},
    {"name": "Luhring Augustine", "url": "https://www.luhringaugustine.com/exhibitions", "area": "Chelsea", "nyc_only": True},
    {"name": "Andrew Kreps", "url": "https://www.andrewkreps.com/exhibitions", "area": "Tribeca", "nyc_only": True},
    {"name": "Jack Shainman", "url": "https://jackshainman.com/exhibitions", "area": "Chelsea"},
    {"name": "Mitchell-Innes & Nash", "url": "https://www.miandn.com/exhibitions", "area": "Chelsea", "nyc_only": True},
    {"name": "Greene Naftali", "url": "https://www.greenenaftaligallery.com/exhibitions", "area": "Chelsea", "nyc_only": True},
    {"name": "James Cohan", "url": "https://www.jamescohan.com/exhibitions", "area": "Tribeca", "nyc_only": True},
    {"name": "Galerie Lelong", "url": "https://www.galerielelong.com/exhibitions", "area": "Chelsea"},
    {"name": "Ryan Lee", "url": "https://ryanleegallery.com/exhibitions", "area": "Chelsea", "nyc_only": True},
    {"name": "Anton Kern", "url": "https://www.antonkerngallery.com/exhibitions", "area": "Midtown", "nyc_only": True},
    {"name": "Nicola Vassell", "url": "https://nicolavassell.com/exhibitions", "area": "Chelsea", "nyc_only": True},
    {"name": "Bortolami", "url": "https://www.bortolamigallery.com/exhibitions", "area": "Tribeca"},
    {"name": "Miguel Abreu", "url": "https://www.miguelabreugallery.com/exhibitions", "area": "Lower East Side", "nyc_only": True},
    {"name": "Van Doren Waxter", "url": "https://www.vandorenwaxter.com/exhibitions", "area": "Upper East Side", "nyc_only": True},
    {"name": "Marian Goodman", "url": "https://www.mariangoodman.com/exhibitions", "area": "Midtown"},
    {"name": "Gladstone", "url": "https://gladstonegallery.com/en/exhibitions/", "area": "Chelsea", "render": True},
]
# Museums are read the same way. All are New York only, and their lists run
# longer, so more exhibition pages are checked ("check").
# Left out on purpose: MoMA, the Met, Brooklyn Museum and El Museo del Barrio
# turn automated requests away; New Museum, the Morgan, Noguchi and Asia
# Society disallow it in robots.txt.
MUSEUMS = [
    {"name": "Whitney Museum", "url": "https://whitney.org/exhibitions", "area": "Meatpacking District"},
    {"name": "The Frick Collection", "url": "https://www.frick.org/exhibitions", "area": "Upper East Side"},
    {"name": "Neue Galerie", "url": "https://www.neuegalerie.org/exhibitions", "area": "Upper East Side"},
    {"name": "The Jewish Museum", "url": "https://thejewishmuseum.org/exhibitions", "area": "Upper East Side"},
    {"name": "The Studio Museum in Harlem", "url": "https://studiomuseum.org/exhibitions", "area": "Harlem"},
    {"name": "ICP", "url": "https://www.icp.org/exhibitions", "area": "Lower East Side"},
    {"name": "Museum of Arts and Design", "url": "https://madmuseum.org/exhibitions", "area": "Columbus Circle"},
    {"name": "The Bronx Museum", "url": "https://www.bronxmuseum.org/exhibitions", "area": "Bronx"},
    {"name": "Museum of the City of New York", "url": "https://www.mcny.org/exhibitions", "area": "Upper East Side"},
    {"name": "The Drawing Center", "url": "https://drawingcenter.org/exhibitions", "area": "SoHo"},
    # Built in the browser: only read when FIRECRAWL_API_KEY is set.
    {"name": "Guggenheim", "url": "https://www.guggenheim.org/exhibitions", "area": "Upper East Side", "render": True},
    {"name": "Cooper Hewitt", "url": "https://www.cooperhewitt.org/exhibitions/", "area": "Upper East Side", "render": True},
    {"name": "Queens Museum", "url": "https://queensmuseum.org/exhibitions/", "area": "Queens", "render": True},
]
for _museum in MUSEUMS:
    _museum.update(kind="museum", nyc_only=True, check=16)

CHECK_PER_GALLERY = 10  # exhibition pages looked at per gallery, newest first

session = requests.Session()
session.headers["User-Agent"] = USER_AGENT
_robots = {}


def load_env():
    """Reads KEY=value lines from Backend/.env into the environment."""
    env = HERE / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


# ---- robots.txt --------------------------------------------------------------
AI_CRAWLERS = re.compile(r"user-agent:\s*(claudebot|claude-web|anthropic-ai|gptbot)\b", re.I)


def allowed(url):
    """True if robots.txt lets us read this page and does not shut out AI crawlers."""
    host = "{0.scheme}://{0.netloc}".format(urlparse(url))
    if host not in _robots:
        try:
            response = session.get(f"{host}/robots.txt", timeout=15)
            text = response.text if response.ok else ""
        except requests.RequestException:
            text = ""
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(text.splitlines())
        blocks_ai = any(
            AI_CRAWLERS.search(block) and re.search(r"disallow:\s*/\s*$", block, re.I | re.M)
            for block in re.split(r"\n\s*\n", text)
        )
        _robots[host] = (parser, blocks_ai)
    parser, blocks_ai = _robots[host]
    return not blocks_ai and parser.can_fetch(USER_AGENT, url)


def fetch(url):
    if not allowed(url):
        raise PermissionError(f"robots.txt does not allow {url}")
    response = session.get(url, timeout=25)
    response.raise_for_status()
    return response


# ---- reading pages -----------------------------------------------------------
LISTING_SKIP = re.compile(
    r"/(past|upcoming|current|forthcoming|archive|all|page|category|tag|year|location|search|online|"
    r"viewing-room|status|institutional)s?(/|$)",
    re.I,
)


def exhibition_links(listing_url, page, limit=CHECK_PER_GALLERY):
    host = urlparse(page.url).netloc.removeprefix("www.")
    found = []
    for href in re.findall(r'href=["\']([^"\']+)["\']', page.text):
        link = urljoin(page.url, htmllib.unescape(href)).split("#")[0].split("?")[0]
        link = re.sub(r"/(installation[_-](shots|views)|works|press|overview)/?$", "/", link)
        path = urlparse(link).path
        if urlparse(link).netloc.removeprefix("www.") != host:
            continue
        if not re.search(r"/exhibitions?/[^/]+", path) or LISTING_SKIP.search(path):
            continue
        if re.search(r"/exhibitions?/?$|/\d{4}(-\d{4})?/?$|\.(jpe?g|png|pdf)$", path, re.I):
            continue
        if link.rstrip("/") not in {f.rstrip("/") for f in found}:
            found.append(link)
    return found[:limit]


MONTHS = {m: i + 1 for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
MON = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
DASH = r"\s*(?:–|—|-|to|through|until)\s*"
YEAR = r"(20\d\d)"
DATE_PATTERNS = [
    # September 10 – November 14, 2026  /  September 10, 2026 – January 3, 2027
    ("mdy", re.compile(MON + r"\s+(\d{1,2})(?:,?\s*" + YEAR + r")?" + DASH + MON + r"\s+(\d{1,2}),?\s*" + YEAR, re.I)),
    # 10 September – 14 November 2026
    ("dmy", re.compile(r"(\d{1,2})\s+" + MON + r"(?:\s+" + YEAR + r")?" + DASH + r"(\d{1,2})\s+" + MON + r",?\s+" + YEAR, re.I)),
    # November 6 – 20, 2026
    ("md-d", re.compile(MON + r"\s+(\d{1,2})" + DASH + r"(\d{1,2}),?\s*" + YEAR, re.I)),
    # through January 23, 2027
    ("through", re.compile(r"(?:through|until|thru)\s+" + MON + r"\s+(\d{1,2}),?\s*" + YEAR, re.I)),
]


def month(name):
    return MONTHS[name[:3].lower()]


def start_year(first_month, end):
    return end.year if first_month <= end.month else end.year - 1


def find_dates(text):
    """(start or None, end, position) of the first date range in the text."""
    for kind, pattern in DATE_PATTERNS:
        for match in pattern.finditer(text):
            g = match.groups()
            try:
                if kind == "mdy":
                    end = date(int(g[5]), month(g[3]), int(g[4]))
                    start = date(int(g[2]) if g[2] else start_year(month(g[0]), end), month(g[0]), int(g[1]))
                elif kind == "dmy":
                    end = date(int(g[5]), month(g[4]), int(g[3]))
                    start = date(int(g[2]) if g[2] else start_year(month(g[1]), end), month(g[1]), int(g[0]))
                elif kind == "md-d":
                    start = date(int(g[3]), month(g[0]), int(g[1]))
                    end = date(int(g[3]), month(g[0]), int(g[2]))
                else:
                    start, end = None, date(int(g[2]), month(g[0]), int(g[1]))
            except ValueError:
                continue
            if start is None or (start <= end and (end - start).days < 400):
                return start, end, match.start()
    return None


META_TAG = re.compile(r"<meta\b[^>]{0,2000}>", re.I)


def meta(page_html, name):
    """A <meta> tag's content, e.g. og:title. Looks at one tag at a time, so a
    large page can never make the search run long."""
    wanted = re.compile(r"""(?:property|name)\s*=\s*["']""" + re.escape(name) + r"""["']""", re.I)
    for tag in META_TAG.findall(page_html):
        if wanted.search(tag):
            found = re.search(r"""content\s*=\s*(?:"([^"]*)"|'([^']*)')""", tag, re.I)
            if found:
                return htmllib.unescape(found.group(1) if found.group(1) is not None else found.group(2)).strip()
    return None


def page_text(page_html):
    page_html = page_html[:600_000]  # very long pages: the show details are near the top
    page_html = re.sub(r"<(script|style|noscript|footer|nav)[^>]*>.*?</\1>", " ", page_html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", page_html)))


NEW_YORK_WORDS = re.compile(
    r"new york|\bnyc\b|chelsea|tribeca|manhattan|brooklyn|hudson yards|"
    r"\b\d{2,3}\s+(?:west|w\.?|east|e\.?)\s+\d{1,2}(?:st|nd|rd|th)\b|\b\d{3}\s+(?:west|w\.?)\s+\d{2}",
    re.I,
)
CITIES = r"new york|los angeles|london|paris|hong kong|seoul|tokyo|geneva|berlin|beijing|shanghai|brussels|monaco|aspen|palm beach|east hampton|basel|milan|rome|kinderhook|tribeca|chelsea|uptown"


OTHER_CITY = re.compile(r"\b(los angeles|london|paris|hong kong|seoul|tokyo|geneva|berlin|beijing|shanghai|brussels|monaco|aspen|palm beach|east hampton|basel|milan|rome|kinderhook)\b", re.I)


def clean_title(raw, gallery):
    parts = re.split(r"\s*(?:\||«|»)\s*|\s+(?:—|–|-)\s+", raw or "")
    keep = []
    name = gallery.lower()
    for part in parts:
        part = part.strip(" -–—:")
        low = part.lower()
        if not part or low in ("exhibitions", "exhibition", "gallery", "current", "upcoming"):
            continue
        # the gallery's own name ("Petzel Gallery", "Almine Rech"), but not a
        # show title that merely mentions it ("Maison Leleu x Luhring Augustine")
        if low.removeprefix("the ") == name.removeprefix("the ") or low in (f"{name} gallery", f"gallery {name}", f"{name} gallery new york"):
            continue
        if re.search(r"\b(19|20)\d\d\b.*\d|^" + MON + r"\s+\d", part, re.I) and len(keep):
            continue
        if re.fullmatch(r"(?:new york|" + CITIES + r")(?::.*)?", part, re.I) or part.lower().startswith("installation"):
            continue
        keep.append(part)
    return ": ".join(keep[:2]) or (raw or "").strip()


def main_image(page_html, base):
    image = meta(page_html, "og:image") or meta(page_html, "twitter:image")
    if image:
        return urljoin(base, image)
    for src in re.findall(r'(?:data-src|src)=["\']([^"\']+\.(?:jpe?g|png|webp)[^"\']*)["\']', page_html, re.I):
        if not re.search(r"logo|icon|w_200,h_50|sprite|favicon", src, re.I):
            return urljoin(base, src)
    return None


def read_exhibition(url, gallery):
    page = fetch(url)
    text = page_text(page.text)
    dates = find_dates(text)
    if not dates:
        return None
    start, end, at = dates
    nearby = text[max(0, at - 400): at + 400]
    if not gallery.get("nyc_only") and not NEW_YORK_WORDS.search(nearby):
        return None  # a show at one of the gallery's other cities
    raw_title = meta(page.text, "og:title") or (re.search(r"<title>(.*?)</title>", page.text, re.S | re.I) or [None, ""])[1]
    title = clean_title(raw_title, gallery["name"])
    if not title or re.search(r"exhibitions$|^(new york|paris|london)\b", title, re.I):
        return None  # a list page, not a show
    if OTHER_CITY.search(raw_title or "") and not NEW_YORK_WORDS.search(raw_title or ""):
        return None  # the title names another city
    if re.search(r"\d+\s+chome|\btokyo\b|\bparis\b|\blondon\b|los angeles", title, re.I):
        return None
    description = meta(page.text, "og:description") or meta(page.text, "description") or ""
    return {
        "id": url,
        "source": "gallery",
        "kind": gallery.get("kind", "gallery"),
        "title": htmllib.unescape(title),
        "venue": gallery["name"],
        "area": gallery["area"],
        "start": start.isoformat() if start else None,
        "end": end.isoformat(),
        "image": main_image(page.text, page.url),
        "link": page.url,
        "description": re.sub(r"\s+", " ", description)[:600],
    }


def read_gallery(gallery):
    if gallery.get("render"):
        return read_rendered_gallery(gallery)
    listing = fetch(gallery["url"])
    shows = []
    for link in exhibition_links(gallery["url"], listing, gallery.get("check", CHECK_PER_GALLERY)):
        time.sleep(PAUSE)
        try:
            show = read_exhibition(link, gallery)
        except (requests.RequestException, PermissionError):
            continue
        if show:
            shows.append(show)
    return shows


# ---- Firecrawl (optional) ------------------------------------------------------
FIRECRAWL_SCHEMA = {
    "type": "object",
    "properties": {
        "exhibitions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Exhibition title, with the artist name if given."},
                    "start_date": {"type": "string", "description": "Opening date as YYYY-MM-DD. Return null if not found."},
                    "end_date": {"type": "string", "description": "Closing date as YYYY-MM-DD. Return null if not found."},
                    "city": {"type": "string", "description": "City of the gallery space showing it. Return null if not found."},
                    "url": {"type": "string", "description": "Link to the exhibition page. Return null if not found."},
                    "image": {"type": "string", "description": "Image URL for the exhibition. Return null if not found."},
                },
                "required": ["title"],
            },
        }
    },
    "required": ["exhibitions"],
}


def read_rendered_gallery(gallery):
    key = os.environ.get("FIRECRAWL_API_KEY")
    if not key or not allowed(gallery["url"]):
        return []
    response = requests.post(
        "https://api.firecrawl.dev/v2/scrape",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "url": gallery["url"],
            "formats": [{
                "type": "json",
                "prompt": f"List the current and upcoming exhibitions on this {gallery.get('kind', 'gallery')} page.",
                "schema": FIRECRAWL_SCHEMA,
            }],
        },
        timeout=90,
    )
    response.raise_for_status()
    shows = []
    for item in ((response.json().get("data") or {}).get("json") or {}).get("exhibitions") or []:
        try:
            end = date.fromisoformat(item.get("end_date") or "")
        except ValueError:
            continue
        city = (item.get("city") or "").lower()
        if city and "new york" not in city and "nyc" not in city:
            continue
        try:
            start = date.fromisoformat(item.get("start_date") or "")
        except ValueError:
            start = None
        shows.append({
            "id": item.get("url") or f"{gallery['name']}:{item['title']}",
            "source": "gallery",
            "kind": gallery.get("kind", "gallery"),
            "title": item["title"],
            "venue": gallery["name"],
            "area": gallery["area"],
            "start": start.isoformat() if start else None,
            "end": end.isoformat(),
            "image": item.get("image"),
            "link": urljoin(gallery["url"], item.get("url") or gallery["url"]),
            "description": "",
        })
    return shows


# ---- SerpApi Google Events (optional) ------------------------------------------
DISCOVER_QUERIES = [
    "art exhibition opening Chelsea New York",
    "art gallery events New York",
    "art installation New York",
]


def discover_events():
    key = os.environ.get("SERPAPI_KEY")
    if not key:
        return []
    found = {}
    for query in DISCOVER_QUERIES:
        response = requests.get(
            "https://serpapi.com/search",
            params={"engine": "google_events", "q": query, "location": "New York, New York, United States", "api_key": key},
            timeout=40,
        )
        response.raise_for_status()
        for item in response.json().get("events_results") or []:
            title = (item.get("title") or "").strip()
            if not title or title.lower() in found:
                continue
            venue = (item.get("venue") or {}).get("name") or ", ".join((item.get("address") or [])[:1])
            found[title.lower()] = {
                "id": item.get("link") or title,
                "source": "discovered",
                "title": title,
                "venue": venue,
                "area": ", ".join((item.get("address") or [])[1:2]) or "New York",
                "when": (item.get("date") or {}).get("when") or (item.get("date") or {}).get("start_date"),
                "image": item.get("image") or item.get("thumbnail"),
                "link": item.get("link") or ((item.get("ticket_info") or [{}])[0].get("link")),
                "description": item.get("description") or "",
            }
    return list(found.values())


# ---- refresh and cache -----------------------------------------------------------
_state = {"shows": [], "discovered": [], "checked": None, "discovered_at": None, "report": {}}
_lock = threading.Lock()


def _save():
    CACHE.mkdir(exist_ok=True)
    (CACHE / "galleries.json").write_text(json.dumps(_state, indent=1))


def _load():
    try:
        _state.update(json.loads((CACHE / "galleries.json").read_text()))
    except (OSError, ValueError):
        pass


def _age_hours(stamp):
    if not stamp:
        return float("inf")
    return (datetime.now() - datetime.fromisoformat(stamp)).total_seconds() / 3600


def refresh(force=False):
    if force or _age_hours(_state["checked"]) >= REFRESH_HOURS:
        shows, report = [], {}
        for gallery in GALLERIES + MUSEUMS:
            try:
                found = read_gallery(gallery)
                report[gallery["name"]] = len(found)
                shows += found
            except PermissionError:
                report[gallery["name"]] = "not allowed by robots.txt"
            except Exception as error:  # one gallery failing must not stop the rest
                report[gallery["name"]] = f"error: {str(error)[:80]}"
            time.sleep(PAUSE)
        with _lock:
            if shows:
                _state["shows"] = shows
            _state["checked"] = datetime.now().isoformat(timespec="seconds")
            _state["report"] = report
            _save()
    if os.environ.get("SERPAPI_KEY") and (force or _age_hours(_state["discovered_at"]) >= DISCOVER_HOURS):
        try:
            discovered = discover_events()
            with _lock:
                _state["discovered"] = discovered
                _state["discovered_at"] = datetime.now().isoformat(timespec="seconds")
                _save()
        except Exception as error:
            print(f"SerpApi search failed: {error}")


def start_background_refresh():
    load_env()
    _load()

    def loop():
        while True:
            try:
                refresh()
            except Exception as error:
                print(f"Gallery refresh failed: {error}")
            time.sleep(1800)

    threading.Thread(target=loop, daemon=True).start()


def current_shows():
    """Shows open now or opening soon, closing soonest first."""
    today = datetime.now(NEW_YORK).date()
    soon = today + timedelta(days=UPCOMING_DAYS)
    with _lock:
        shows = list(_state["shows"])
    keep = {}
    for show in shows:
        end = date.fromisoformat(show["end"])
        start = date.fromisoformat(show["start"]) if show.get("start") else None
        if end < today or (start and start > soon):
            continue
        show = {**show, "opening": bool(start and start > today)}
        keep.setdefault(show["link"].rstrip("/"), show)
    return sorted(keep.values(), key=lambda show: (show["opening"], show["end"]))


def discovered_events():
    with _lock:
        return list(_state["discovered"])


def status():
    with _lock:
        return {"checked": _state["checked"], "galleries": _state["report"],
                "serpapi": bool(os.environ.get("SERPAPI_KEY")), "firecrawl": bool(os.environ.get("FIRECRAWL_API_KEY"))}


if __name__ == "__main__":
    # python galleries.py  — reads every gallery now and prints what it found.
    load_env()
    refresh(force=True)
    for name, result in _state["report"].items():
        print(f"{name:24} {result}")
    print()
    for show in current_shows():
        print(f"{'OPENS ' + show['start'] if show['opening'] else 'until ' + show['end']:18} {show['venue'][:20]:20} {show['title'][:60]}")
