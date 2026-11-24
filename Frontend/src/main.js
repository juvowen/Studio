import './archive.css'
import './music.js'
import { accountLink } from './auth.js'

// SIGN IN / SIGN OUT, top right.
document.querySelector('.masthead').append(accountLink())
