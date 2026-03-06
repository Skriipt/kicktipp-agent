"""KickTipp BetBot
Automated kicktipp.com bet placement.

Places bets to the upcomming matchday.
Unless specified by parameter it places the bets on all prediction games of the account.

On first run you will be prompted for your kicktipp.com credentials.
They are stored in ~/.config/kicktipp-cli/ for subsequent runs.

Usage:
    kicktippbb.py [ --list-predictors ]
    kicktippbb.py [ --list-communities ]
    kicktippbb.py [ --set-community ]
    kicktippbb.py [ --list-players ]
    kicktippbb.py [ --set-player ]
    kicktippbb.py [ --leaderboard ] [--matchday <value>] [--bonus]
    kicktippbb.py [ --overview ] [--view <value>]
    kicktippbb.py [ --schedule ] [--matchday <value>]
    kicktippbb.py [ --table ] [--home] [--away]
    kicktippbb.py [ --bets ] [--matchday <value>]
    kicktippbb.py [ --set-bets ] [--matchday <value>]
    kicktippbb.py [ --set-all-bets BETS ] [--matchday <value>]
    kicktippbb.py [ --auto-bets ] [--matchday <value>] [--predictor <value>] [--override-bets] [--dry-run]
    kicktippbb.py [ --rules ]
    kicktippbb.py [ --logout ]
    kicktippbb.py [--dry-run] [--override-bets] [--deadline <duration>] [--predictor <value>] [--matchday <value>] [COMMUNITY]...

Options:
    COMMUNITY                   Name of the prediction game community to place bets on,
                                one or more names can be specified.
                                If no community name is given the saved community is used,
                                or all available communities if none is saved.
    --list-communities          Display a list of all communities the user has access to.
    --set-community             Select a community to use as default when no COMMUNITY is specified.
    --list-players              Display a list of all players in the saved community.
    --set-player                Select which player you are and save it.
    --leaderboard               Show the leaderboard for the current (or specified) matchday.
    --bonus                     Show the bonus questions leaderboard instead of the matchday one.
    --overview                  Show the season overview table.
    --view <value>              Which overview to show [default: matchday-points].
                                Options: matchday-points, standings, standings-diff,
                                matchday-standings, points-from-leader
    --bets                      Show your bets for the current (or specified) matchday.
    --set-bets                  Manually set bets for editable matches. Press Enter to skip a match.
    --set-all-bets BETS         Set all bets at once, e.g. "2:1 0:0 3:1 1:1 ...". Use - to skip a match.
    --auto-bets                 Automatically place bets using a predictor on the saved community.
    --rules                     Show the game rules for the community.
    --schedule                  Show the match schedule for the current (or specified) matchday.
    --table                     Show the league table.
    --home                      Show the home table (use with --table).
    --away                      Show the away table (use with --table).
    --logout                    Remove stored credentials and session, then exit.
    --override-bets             Override already placed bets.
    --deadline <duration>       Only place bets on matches that start in <duration> from now.
                                The duration format is <number><unit[m,h,d]>, e.g. 10m,5h or 1d
    --list-predictors           Display a list of predictors available to be used with '--predictor' option
    --predictor <value>         A specific predictor name to be used during calculation
    --dry-run                   Dont place any bet just print out predicitons
    --matchday <value>          Choose a specific matchday in the range of 1 to 34 to place bets on
"""

import sys
import configparser
import datetime
import getpass
import itertools
import os
import re
import shutil
import threading
import time

from docopt import docopt
from playwright.sync_api import sync_playwright, Page
from bs4 import BeautifulSoup

import predictors.base
from helper.deadline import is_before_dealine, timedelta_tostring
from helper.match import Match

URL_BASE = 'https://www.kicktipp.com'
URL_LOGIN = URL_BASE + '/info/profil/login'

CONFIG_DIR = os.path.join(os.path.expanduser('~'), '.config', 'kicktipp-cli')
CONFIG_FILE = os.path.join(CONFIG_DIR, 'config.ini')
SESSION_FILE = os.path.join(CONFIG_DIR, 'session.json')

DEADLINE_REGEX = re.compile('([1-9][0-9]*)(m|h|d)')


def load_credentials():
    """Load credentials from config file, or prompt and save them."""
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE)

    email = config.get('auth', 'email', fallback=None)
    password = config.get('auth', 'password', fallback=None)

    if email and password:
        return email, password

    print("No credentials found. Please enter your kicktipp.com login:")
    email = input("Email: ")
    password = getpass.getpass("Password: ")

    os.makedirs(CONFIG_DIR, exist_ok=True)
    config['auth'] = {'email': email, 'password': password}
    with open(CONFIG_FILE, 'w') as f:
        config.write(f)
    os.chmod(CONFIG_FILE, 0o600)
    print("Credentials saved to {}".format(CONFIG_FILE))

    return email, password


def load_community():
    """Load saved community from config file."""
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE)
    return config.get('community', 'name', fallback=None)


def save_community(name):
    """Save selected community to config file."""
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE)
    if not config.has_section('community'):
        config.add_section('community')
    config.set('community', 'name', name)
    with open(CONFIG_FILE, 'w') as f:
        config.write(f)


def load_player():
    """Load saved player name from config file."""
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE)
    return config.get('player', 'name', fallback=None)


def save_player(name):
    """Save selected player name to config file."""
    config = configparser.ConfigParser()
    config.read(CONFIG_FILE)
    if not config.has_section('player'):
        config.add_section('player')
    config.set('player', 'name', name)
    with open(CONFIG_FILE, 'w') as f:
        config.write(f)


def get_players(page: Page, community):
    """Fetch player names from the leaderboard ranking table."""
    status("Fetching players...")
    page.goto(get_leaderboard_url(community))
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    ranking = soup.find('table', id='ranking')
    if not ranking:
        return []
    tbody = ranking.find('tbody')
    if not tbody:
        return []
    players = []
    for tr in tbody.find_all('tr'):
        name_div = tr.find('div', class_='mg_name')
        if name_div:
            players.append(name_div.get_text().strip())
    return players


def set_player(page: Page, community):
    """Prompt user to select their player and save it."""
    players = get_players(page, community)
    if not players:
        exit("No players found.")
    print("Players:")
    for i, name in enumerate(players, 1):
        print("  [{}] {}".format(i, name))
    choice = input("Which one are you? (1-{}): ".format(len(players)))
    try:
        idx = int(choice) - 1
        if idx < 0 or idx >= len(players):
            raise ValueError()
    except ValueError:
        exit("Invalid selection.")
    selected = players[idx]
    save_player(selected)
    print("Saved '{}' as your player.".format(selected))


def set_community(page: Page):
    """Prompt user to select a community and save it."""
    all_communities = get_communities(page, [])
    status_clear()
    if not all_communities:
        exit("No communities found.")
    print("Available communities:")
    for i, com in enumerate(all_communities, 1):
        print("  [{}] {}".format(i, com))
    choice = input("Select community (1-{}): ".format(len(all_communities)))
    try:
        idx = int(choice) - 1
        if idx < 0 or idx >= len(all_communities):
            raise ValueError()
    except ValueError:
        exit("Invalid selection.")
    selected = all_communities[idx]
    save_community(selected)
    print("Saved '{}' as default community.".format(selected))


def logout():
    """Remove stored credentials and session."""
    removed = []
    for path in [CONFIG_FILE, SESSION_FILE]:
        if os.path.exists(path):
            os.remove(path)
            removed.append(path)
    if removed:
        print("Removed: {}".format(', '.join(removed)))
    else:
        print("Nothing to remove.")


class Spinner:
    """A simple terminal spinner that runs in a background thread."""
    FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

    def __init__(self):
        self._msg = ''
        self._active = False
        self._thread = None
        self._lock = threading.Lock()

    def _run(self):
        frames = itertools.cycle(self.FRAMES)
        while self._active:
            with self._lock:
                msg = self._msg
            cols = shutil.get_terminal_size().columns
            line = next(frames) + ' ' + msg
            sys.stdout.write('\r' + line[:cols].ljust(cols) + '\r')
            sys.stdout.flush()
            time.sleep(0.08)

    def start(self, msg):
        with self._lock:
            self._msg = msg
        if not self._active:
            self._active = True
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def stop(self):
        self._active = False
        if self._thread:
            self._thread.join()
            self._thread = None
        cols = shutil.get_terminal_size().columns
        sys.stdout.write('\r' + ' ' * cols + '\r')
        sys.stdout.flush()


_spinner = Spinner()


def status(msg):
    """Show a spinning status message."""
    _spinner.start(msg)


def status_clear():
    """Stop the spinner and clear the line."""
    _spinner.stop()


def dismiss_consent(page: Page):
    """Dismiss the cookie consent dialog if present."""
    try:
        page.wait_for_selector('iframe[src*="privacy-mgmt"]', timeout=2000)
        for frame in page.frames:
            btn = frame.query_selector('button:has-text("Accept and continue")')
            if btn:
                btn.click()
                page.wait_for_selector('iframe[src*="privacy-mgmt"]', state='hidden', timeout=3000)
                return
    except:
        pass


def login(page: Page, username: str, password: str):
    """Log into the user account with the given credentials."""
    status("Logging in...")
    page.goto(URL_LOGIN)
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    page.fill('input[name="kennung"]', username)
    page.fill('input[name="passwort"]', password)
    with page.expect_navigation():
        page.click('button[type="submit"]')

    if '/login' in page.url:
        status_clear()
        exit("Login failed. Check your credentials (use --logout to re-enter).")


def get_table_rows(soup):
    """
    Get all table rows from the first tbody element found in soup parameter
    """
    tbody = soup.find('tbody')
    if not tbody:
        return []
    return [tr.find_all('td') for tr in tbody.find_all('tr')]


def parse_odds(odds_td):
    """Parse odds from structured HTML spans."""
    home = odds_td.find('span', class_='quote-heim')
    draw = odds_td.find('span', class_='quote-remis')
    road = odds_td.find('span', class_='quote-gast')
    return (
        home.find('span', class_='quote-text').get_text().strip(),
        draw.find('span', class_='quote-text').get_text().strip(),
        road.find('span', class_='quote-text').get_text().strip(),
    )


def parse_bet_arg(arg):
    """Parse a bet argument like 'Home vs Away=H:G' into (home, away, h, g)."""
    if '=' not in arg:
        exit("Invalid bet '{}'. Use format: Home vs Away=H:G".format(arg))
    fixture, _, result = arg.rpartition('=')
    if ' vs ' not in fixture:
        exit("Invalid fixture '{}'. Use format: Home vs Away=H:G".format(arg))
    home, _, away = fixture.partition(' vs ')
    home = home.strip()
    away = away.strip()
    if not home or not away:
        exit("Invalid fixture '{}'. Both team names required.".format(arg))
    parts = result.split(':')
    if len(parts) != 2:
        exit("Invalid result '{}'. Use format H:G (e.g. 2:1)".format(result))
    try:
        h = int(parts[0])
        g = int(parts[1])
    except ValueError:
        exit("Invalid result '{}'. Use format H:G (e.g. 2:1)".format(result))
    return (home, away, h, g)


def match_fixture(home, away, editable):
    """Find a fixture in editable list by case-insensitive exact match.
    editable: list of (home, away, heim_name, gast_name) tuples.
    Returns the matching tuple or exits with error.
    """
    for entry in editable:
        if entry[0].lower() == home.lower() and entry[1].lower() == away.lower():
            return entry
    exit('No match found for "{} vs {}"'.format(home, away))


def parse_match_rows(page: Page, community, matchday=None):
    """Fetch latest odds for each match
    Returns a list of tuples (input_name_heim, input_name_gast, match)
    """
    page.goto(get_predict_url(community, matchday))
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')
    rows = get_table_rows(content)

    matchtuple = list()
    lastmatch = None
    for row in rows:
        heimtipp = row[3].find(
            'input', id=lambda x: x and x.endswith('_heimTipp'))
        gasttipp = row[3].find(
            'input', id=lambda x: x and x.endswith('_gastTipp'))
        try:
            rate_home, rate_deuce, rate_road = parse_odds(row[4])
            match = Match(row[1].get_text(), row[2].get_text(), row[0].get_text(),
                          rate_home, rate_deuce, rate_road)
        except:
            print("Error: Not enough data, maybe there are no rates yet.")
            sys.exit()
        if not match.match_date:
            match.match_date = lastmatch.match_date
        lastmatch = match
        matchtuple.append((
            heimtipp['name'] if heimtipp else None,
            gasttipp['name'] if gasttipp else None,
            match
        ))

    return matchtuple


def get_predict_url(community, matchday=None):
    predict_url = URL_BASE + '/' + community + '/predict'
    if matchday is None:
        return predict_url
    else:
        matchday = int(matchday)
        if matchday < 1 or matchday > 34:
            raise IndexError("The matchday '{}' is not valid, use only 1 to 34!".format(matchday))
        return predict_url + '?spieltagIndex={matchday}'.format(matchday=matchday)


def get_communities(page: Page, desired_communities: list):
    """
    Get a list of all communities of the user
    """
    status("Fetching communities...")
    page.goto(URL_BASE + '/info/profil/meinetipprunden')
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')
    links = content.find_all('a')

    def gethreftext(link): return link.get('href').replace("/", "")

    def is_community(link):
        hreftext = gethreftext(link)
        if hreftext.lower() == link.get_text().lower():
            return True
        else:
            linkdiv = link.find('div', {'class': "menu-title-mit-tippglocke"})
            return linkdiv and linkdiv.get_text().lower() == hreftext.lower()

    community_list = [gethreftext(link)
                      for link in links if is_community(link)]
    if len(desired_communities) > 0:
        return intersection(community_list, desired_communities)
    return community_list


def intersection(a, b):
    i = [x for x in a if x in b]
    return i


def place_bets(page: Page, communities: list, predictor, override=False, deadline=None, dryrun=False, matchday=None):
    """Place bets on all given communities."""
    for com in communities:
        status("Loading {0}...".format(com))
        matches = parse_match_rows(page, com, matchday)
        status_clear()
        print("Community: {0}".format(com))
        if not matches:
            print("  No active matchday found, skipping.")
            continue

        for input_name_heim, input_name_gast, match in matches:
            if not input_name_heim or not input_name_gast:
                print("{0} - no bets possible".format(match))
                continue

            heim_input = page.query_selector('input[name="{}"]'.format(input_name_heim))
            gast_input = page.query_selector('input[name="{}"]'.format(input_name_gast))
            input_hometeam_value = heim_input.input_value() if heim_input else ''
            input_roadteam_value = gast_input.input_value() if gast_input else ''

            if not override and (input_hometeam_value or input_roadteam_value):
                print("{0} - skipped, already placed {1}:{2}".format(match,
                                                                     input_hometeam_value, input_roadteam_value))
                continue

            if deadline is not None:
                if not is_before_dealine(deadline, match.match_date):
                    time_to_match = match.match_date - datetime.datetime.now()
                    print("{0} - not betting yet, due in {1}".format(match,
                                                                     timedelta_tostring(time_to_match)))
                    continue

            homebet, roadbet = predictor.predict(match)
            print("{0} - betting {1}:{2}".format(match, homebet, roadbet))
            heim_input.fill(str(homebet))
            gast_input.fill(str(roadbet))

        if not dryrun:
            with page.expect_navigation():
                page.click('button[name="submitbutton"]')
        else:
            print("INFO: Dry run, no bets were placed")


def get_leaderboard_url(community, matchday=None, bonus=False):
    url = URL_BASE + '/' + community + '/leaderboard'
    params = []
    if bonus:
        params.append('bonus=true')
    if matchday is not None:
        matchday = int(matchday)
        if matchday < 1 or matchday > 34:
            raise IndexError("The matchday '{}' is not valid, use only 1 to 34!".format(matchday))
        params.append('spieltagIndex={}'.format(matchday))
    if params:
        url += '?' + '&'.join(params)
    return url


def show_leaderboard(page: Page, community, matchday=None, bonus=False):
    """Fetch and display the leaderboard."""
    status("Loading leaderboard...")
    page.goto(get_leaderboard_url(community, matchday, bonus=bonus))
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')

    # Print title
    title_div = content.find('div', class_='pagetitle')
    if title_div:
        print(title_div.get_text().strip())
    print()

    if bonus:
        _show_bonus_questions(content)
    else:
        _show_matches(content)

    _show_rankings(content, bonus=bonus)


def _show_matches(content):
    """Display the matches table."""
    matches_table = content.find('table', id='spielplanSpiele')
    if not matches_table:
        return
    tbody = matches_table.find('tbody')
    if not tbody:
        return
    match_rows = []
    for tr in tbody.find_all('tr', recursive=False):
        cols = tr.find_all('td', recursive=False)
        if len(cols) < 4:
            continue
        date = cols[0].get_text().strip()
        home = cols[1].get_text().strip()
        away = cols[2].get_text().strip()
        result_spans = cols[3].find('span', class_='kicktipp-ergebnis')
        if result_spans:
            h = result_spans.find('span', class_='kicktipp-heim').get_text().strip()
            g = result_spans.find('span', class_='kicktipp-gast').get_text().strip()
            result = '{}:{}'.format(h, g)
        else:
            result = '-:-'
        match_rows.append((date, home, away, result))

    if match_rows:
        home_width = max(len(r[1]) for r in match_rows)
        away_width = max(len(r[2]) for r in match_rows)
        print("Matches:")
        for date, home, away, result in match_rows:
            print("  {:<17s} {:>{hw}s} vs {:<{aw}s}  {}".format(
                date, home, away, result, hw=home_width, aw=away_width))
        print()


def _show_bonus_questions(content):
    """Display the bonus questions table."""
    # The first table in the content is the questions table
    questions_table = content.find('table', class_='ktable')
    if not questions_table:
        return
    tbody = questions_table.find('tbody', recursive=False)
    if not tbody:
        return
    questions = []
    for tr in tbody.find_all('tr', recursive=False):
        cols = tr.find_all('td', recursive=False)
        if len(cols) < 4:
            continue
        question = cols[1].get_text().strip()
        abbr = cols[2].get_text().strip()
        # Result column has a nested subtable with answers
        result_parts = []
        subtable = cols[3].find('table')
        if subtable:
            for sub_tr in subtable.find_all('tr'):
                medium = sub_tr.find('div', class_='visible-medium-block')
                if medium:
                    result_parts.append(medium.get_text().strip())
        result = ', '.join(result_parts) if result_parts else '---'
        questions.append((abbr, question, result))

    if questions:
        abbr_width = max(len(q[0]) for q in questions)
        q_width = max(len(q[1]) for q in questions)
        print("Bonus Questions:")
        for abbr, question, result in questions:
            print("  {:<{aw}s}  {:<{qw}s}  {}".format(
                abbr, question, result, aw=abbr_width, qw=q_width))
        print()


def _show_rankings(content, bonus=False):
    """Display the ranking table."""
    ranking_table = content.find('table', id='ranking')
    if not ranking_table:
        return
    tbody = ranking_table.find('tbody')
    if not tbody:
        return
    players = []
    for tr in tbody.find_all('tr'):
        pos_td = tr.find('td', class_='position')
        name_div = tr.find('div', class_='mg_name')
        md_td = tr.find('td', class_='spieltagspunkte')
        bonus_td = tr.find('td', class_='bonus')
        total_td = tr.find('td', class_='gesamtpunkte')
        if pos_td and name_div:
            players.append((
                pos_td.get_text().strip(),
                name_div.get_text().strip(),
                md_td.get_text().strip() if md_td else '',
                bonus_td.get_text().strip() if bonus_td else '',
                total_td.get_text().strip() if total_td else '',
            ))

    if players:
        saved_player = load_player()
        name_width = max(len(p[1]) for p in players)
        print("Rankings:")
        if bonus:
            print("  {:<5s} {:<{nw}s} {:>5s} {:>6s}".format(
                "Pos", "Name", "Bonus", "Total", nw=name_width))
            print("  {}".format("-" * (name_width + 19)))
            for pos, name, md, bns, total in players:
                marker = " <" if saved_player and name == saved_player else ""
                print("  {:<5s} {:<{nw}s} {:>5s} {:>6s}{}".format(
                    pos, name, bns, total, marker, nw=name_width))
        else:
            print("  {:<5s} {:<{nw}s} {:>5s} {:>5s} {:>6s}".format(
                "Pos", "Name", "MD", "Bonus", "Total", nw=name_width))
            print("  {}".format("-" * (name_width + 24)))
            for pos, name, md, bns, total in players:
                marker = " <" if saved_player and name == saved_player else ""
                print("  {:<5s} {:<{nw}s} {:>5s} {:>5s} {:>6s}{}".format(
                    pos, name, md, bns, total, marker, nw=name_width))


OVERVIEW_VIEWS = {
    'matchday-points': ('spieltagspunkte', 'Matchday points'),
    'standings': ('platzierungen', 'Standings'),
    'standings-diff': ('platzierungsdifferenz', 'Standings difference'),
    'matchday-standings': ('spieltagsplatzierungen', 'Matchday standings'),
    'points-from-leader': ('punkteZurSpitze', 'Points from leader'),
}


def show_overview(page: Page, community, view='matchday-points'):
    """Fetch and display the season overview."""
    if view not in OVERVIEW_VIEWS:
        exit("Unknown view '{}'. Options: {}".format(view, ', '.join(OVERVIEW_VIEWS.keys())))

    ansicht, label = OVERVIEW_VIEWS[view]
    status("Loading overview...")
    url = URL_BASE + '/' + community + '/overview?ansicht=' + ansicht
    page.goto(url)
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')

    print("Overview: {}".format(label))
    print()

    ranking = content.find('table', id='ranking')
    if not ranking:
        print("No data found.")
        return

    tbody = ranking.find('tbody')
    if not tbody:
        return

    # Parse all rows
    saved_player = load_player()
    players = []
    max_matchday = 0
    for tr in tbody.find_all('tr'):
        pos_td = tr.find('td', class_='position')
        name_div = tr.find('div', class_='mg_name')
        if not pos_td or not name_div:
            continue

        pos = pos_td.get_text().strip()
        name = name_div.get_text().strip()

        matchdays = {}
        for td in tr.find_all('td', class_='spieltag'):
            classes = td.get('class', [])
            for cls in classes:
                if cls.startswith('spieltag') and cls != 'spieltag':
                    idx = int(cls.replace('spieltag', ''))
                    val = td.get_text().strip()
                    if val:
                        matchdays[idx] = val
                        if idx > max_matchday:
                            max_matchday = idx

        bonus_td = tr.find('td', class_='bonus')
        siege_td = tr.find('td', class_='siege')
        punkte_td = tr.find('td', class_='punkte')
        bonus = bonus_td.get_text().strip() if bonus_td else ''
        siege = siege_td.get_text().strip() if siege_td else ''
        total = punkte_td.get_text().strip() if punkte_td else ''

        players.append((pos, name, matchdays, bonus, siege, total))

    if not players:
        print("No data found.")
        return

    name_width = max(len(p[1]) for p in players)
    md_range = range(1, max_matchday + 1)

    # Header
    header = "  {:<5s} {:<{nw}s}".format("Pos", "Name", nw=name_width)
    for md in md_range:
        header += " {:>3s}".format(str(md))
    header += "  {:>3s} {:>4s} {:>5s}".format("B", "W", "T")
    print(header)
    print("  {}".format("-" * (len(header) - 2)))

    # Rows
    for pos, name, matchdays, bonus, siege, total in players:
        marker = " <" if saved_player and name == saved_player else ""
        line = "  {:<5s} {:<{nw}s}".format(pos, name, nw=name_width)
        for md in md_range:
            line += " {:>3s}".format(matchdays.get(md, ''))
        line += "  {:>3s} {:>4s} {:>5s}{}".format(bonus, siege, total, marker)
        print(line)


def show_bets(page: Page, community, matchday=None):
    """Show bets/predictions for a matchday."""
    status("Loading bets...")
    page.goto(get_predict_url(community, matchday))
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')

    title_div = content.find('div', class_='pagetitle')
    if title_div:
        print(title_div.get_text().strip())
    print()

    tbody = content.find('tbody')
    if not tbody:
        print("No matches found.")
        return

    rows_data = []
    for tr in tbody.find_all('tr', recursive=False):
        cols = tr.find_all('td', recursive=False)
        if len(cols) < 5:
            continue
        date = cols[0].get_text().strip()
        home = cols[1].get_text().strip()
        away = cols[2].get_text().strip()

        bet_td = cols[3]
        if 'nichttippbar' in bet_td.get('class', []):
            # Past matchday — shows locked prediction as text
            bet = bet_td.get_text().strip()
        else:
            # Current matchday — read values from inputs
            heim_input = bet_td.find('input', id=lambda x: x and x.endswith('_heimTipp'))
            gast_input = bet_td.find('input', id=lambda x: x and x.endswith('_gastTipp'))
            if heim_input and gast_input:
                h = heim_input.get('value', '')
                g = gast_input.get('value', '')
                if h and g:
                    bet = '{}-{}'.format(h, g)
                else:
                    bet = '-'
            else:
                bet = '-'

        rate_home, rate_deuce, rate_road = parse_odds(cols[4])
        odds = '({}/{}/{})'.format(rate_home, rate_deuce, rate_road)

        rows_data.append((date, home, away, bet, odds))

    if rows_data:
        home_width = max(len(r[1]) for r in rows_data)
        away_width = max(len(r[2]) for r in rows_data)
        for date, home, away, bet, odds in rows_data:
            print("  {:<17s} {:>{hw}s} vs {:<{aw}s}  {:>5s}  {}".format(
                date, home, away, bet, odds, hw=home_width, aw=away_width))


def set_bets(page: Page, community, matchday=None):
    """Manually set bets for editable matches."""
    status("Loading bets...")
    page.goto(get_predict_url(community, matchday))
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')

    title_div = content.find('div', class_='pagetitle')
    if title_div:
        print(title_div.get_text().strip())
    print()

    tbody = content.find('tbody')
    if not tbody:
        print("No matches found.")
        return

    editable = []
    for tr in tbody.find_all('tr', recursive=False):
        cols = tr.find_all('td', recursive=False)
        if len(cols) < 5:
            continue
        bet_td = cols[3]
        if 'nichttippbar' in bet_td.get('class', []):
            continue
        heim_input = bet_td.find('input', id=lambda x: x and x.endswith('_heimTipp'))
        gast_input = bet_td.find('input', id=lambda x: x and x.endswith('_gastTipp'))
        if heim_input and gast_input:
            date = cols[0].get_text().strip()
            home = cols[1].get_text().strip()
            away = cols[2].get_text().strip()
            current_h = heim_input.get('value', '')
            current_g = gast_input.get('value', '')
            current = '{}:{}'.format(current_h, current_g) if current_h and current_g else ''
            editable.append((date, home, away, current,
                             heim_input['name'], gast_input['name']))

    if not editable:
        print("No editable matches found.")
        return

    changed = False
    for date, home, away, current, heim_name, gast_name in editable:
        prompt = "  {} {} vs {} ".format(date, home, away)
        if current:
            prompt += "[{}] ".format(current)
        prompt += "(e.g. 2:1, Enter to skip): "
        answer = input(prompt).strip()
        if not answer:
            continue
        parts = answer.replace('-', ':').split(':')
        if len(parts) != 2:
            print("    Invalid format, skipping.")
            continue
        try:
            h = int(parts[0])
            g = int(parts[1])
        except ValueError:
            print("    Invalid format, skipping.")
            continue
        heim_el = page.query_selector('input[name="{}"]'.format(heim_name))
        gast_el = page.query_selector('input[name="{}"]'.format(gast_name))
        heim_el.fill(str(h))
        gast_el.fill(str(g))
        changed = True

    if changed:
        with page.expect_navigation():
            page.click('button[name="submitbutton"]')
        print("\nBets saved.")
    else:
        print("\nNo changes made.")


def set_all_bets(page: Page, community, bets_str, matchday=None):
    """Set all bets at once from a string like '2:1 0:0 3:1'."""
    status("Loading bets...")
    page.goto(get_predict_url(community, matchday))
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')

    tbody = content.find('tbody')
    if not tbody:
        print("No matches found.")
        return

    editable = []
    for tr in tbody.find_all('tr', recursive=False):
        cols = tr.find_all('td', recursive=False)
        if len(cols) < 5:
            continue
        bet_td = cols[3]
        if 'nichttippbar' in bet_td.get('class', []):
            continue
        heim_input = bet_td.find('input', id=lambda x: x and x.endswith('_heimTipp'))
        gast_input = bet_td.find('input', id=lambda x: x and x.endswith('_gastTipp'))
        if heim_input and gast_input:
            home = cols[1].get_text().strip()
            away = cols[2].get_text().strip()
            editable.append((home, away, heim_input['name'], gast_input['name']))

    if not editable:
        print("No editable matches found.")
        return

    bets = bets_str.split()
    if len(bets) != len(editable):
        exit("Expected {} bets but got {}. Editable matches:\n{}".format(
            len(editable), len(bets),
            '\n'.join("  {} vs {}".format(h, a) for h, a, _, _ in editable)))

    changed = False
    for i, (home, away, heim_name, gast_name) in enumerate(editable):
        bet = bets[i]
        if bet == '-':
            print("  {} vs {} - skipped".format(home, away))
            continue
        parts = bet.replace('-', ':').split(':')
        if len(parts) != 2:
            exit("Invalid bet '{}' for {} vs {}. Use format like 2:1".format(bet, home, away))
        try:
            h = int(parts[0])
            g = int(parts[1])
        except ValueError:
            exit("Invalid bet '{}' for {} vs {}. Use format like 2:1".format(bet, home, away))
        print("  {} vs {} - {}:{}".format(home, away, h, g))
        heim_el = page.query_selector('input[name="{}"]'.format(heim_name))
        gast_el = page.query_selector('input[name="{}"]'.format(gast_name))
        heim_el.fill(str(h))
        gast_el.fill(str(g))
        changed = True

    if changed:
        with page.expect_navigation():
            page.click('button[name="submitbutton"]')
        print("\nBets saved.")
    else:
        print("\nNo changes made.")


def show_rules(page: Page, community):
    """Fetch and display the game rules."""
    status("Loading rules...")
    page.goto(URL_BASE + '/' + community + '/rules')
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')
    pagecontent = content.find('div', class_='pagecontent')
    if not pagecontent:
        print("No rules found.")
        return

    print("Game Rules")
    print()

    for child in pagecontent.children:
        if child.name == 'h2':
            print(child.get_text().strip())
        elif child.name == 'p':
            print("  {}".format(child.get_text().strip()))
            print()
        elif child.name == 'div':
            table = child.find('table')
            if table:
                thead = table.find('thead')
                tbody = table.find('tbody')
                if thead and tbody:
                    headers = [th.get_text().strip() for th in thead.find_all('th')]
                    rows = []
                    for tr in tbody.find_all('tr'):
                        rows.append([td.get_text().strip() for td in tr.find_all('td')])
                    # Calculate column widths
                    col_widths = [len(h) for h in headers]
                    for row in rows:
                        for i, cell in enumerate(row):
                            if i < len(col_widths):
                                col_widths[i] = max(col_widths[i], len(cell))
                    # Print table
                    header_line = "  " + "  ".join("{:<{w}s}".format(h, w=col_widths[i]) for i, h in enumerate(headers))
                    print(header_line)
                    print("  {}".format("-" * (len(header_line) - 2)))
                    for row in rows:
                        print("  " + "  ".join("{:<{w}s}".format(row[i] if i < len(row) else '', w=col_widths[i]) for i in range(len(headers))))
                    print()
            else:
                text = child.get_text().strip()
                if text and 'level0' not in str(child.get('class', [])):
                    p_tag = child.find('p')
                    if p_tag:
                        print("  {}".format(child.get_text().strip()))
                        print()


def show_schedule(page: Page, community, matchday=None):
    """Fetch and display the match schedule."""
    status("Loading schedule...")
    url = URL_BASE + '/' + community + '/schedule'
    if matchday is not None:
        matchday = int(matchday)
        if matchday < 1 or matchday > 34:
            raise IndexError("The matchday '{}' is not valid, use only 1 to 34!".format(matchday))
        url += '?spieltagIndex={}'.format(matchday)
    page.goto(url)
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')

    title_div = content.find('div', class_='pagetitle')
    if title_div:
        print(title_div.get_text().strip())
    print()

    table = content.find('table', id='spiele')
    if not table:
        print("No schedule found.")
        return
    tbody = table.find('tbody')
    if not tbody:
        return

    matches = []
    for tr in tbody.find_all('tr', recursive=False):
        cols = tr.find_all('td', recursive=False)
        if len(cols) < 5:
            continue
        date = cols[0].get_text().strip()
        home = cols[2].get_text().strip()
        away = cols[3].get_text().strip()
        result_spans = cols[4].find('span', class_='kicktipp-ergebnis')
        if result_spans:
            h = result_spans.find('span', class_='kicktipp-heim').get_text().strip()
            g = result_spans.find('span', class_='kicktipp-gast').get_text().strip()
            result = '{}:{}'.format(h, g)
        else:
            result = '-:-'
        matches.append((date, home, away, result))

    if matches:
        home_width = max(len(m[1]) for m in matches)
        away_width = max(len(m[2]) for m in matches)
        for date, home, away, result in matches:
            print("  {:<17s} {:>{hw}s} vs {:<{aw}s}  {}".format(
                date, home, away, result, hw=home_width, aw=away_width))


def show_table(page: Page, community, option=None):
    """Fetch and display the league table."""
    status("Loading table...")
    url = URL_BASE + '/' + community + '/tables'
    if option:
        url += '?option={}'.format(option)
    page.goto(url)
    page.wait_for_load_state('domcontentloaded')
    dismiss_consent(page)
    status_clear()

    soup = BeautifulSoup(page.content(), 'html.parser')
    content = soup.find(id='kicktipp-content')

    label = 'League Table'
    if option == 'heim':
        label = 'League Table (Home)'
    elif option == 'gast':
        label = 'League Table (Away)'
    print(label)
    print()

    table = content.find('table')
    if not table:
        print("No table found.")
        return
    tbody = table.find('tbody')
    if not tbody:
        return

    teams = []
    for tr in tbody.find_all('tr', recursive=False):
        cols = tr.find_all('td', recursive=False)
        if len(cols) < 10:
            continue
        pos = cols[0].get_text().strip()
        team = cols[1].get_text().strip()
        played = cols[2].get_text().strip()
        pts = cols[3].get_text().strip()
        gf = cols[4].get_text().strip()
        ga = cols[5].get_text().strip()
        gd = cols[6].get_text().strip()
        w = cols[7].get_text().strip()
        d = cols[8].get_text().strip()
        l = cols[9].get_text().strip()
        teams.append((pos, team, played, pts, gf, ga, gd, w, d, l))

    if teams:
        tw = max(len(t[1]) for t in teams)
        print("  {:<5s} {:<{tw}s} {:>3s} {:>4s} {:>3s} {:>3s} {:>4s} {:>3s} {:>3s} {:>3s}".format(
            "Pos", "Team", "P", "Pts", "GF", "GA", "GD", "W", "D", "L", tw=tw))
        print("  {}".format("-" * (tw + 33)))
        for pos, team, played, pts, gf, ga, gd, w, d, l in teams:
            print("  {:<5s} {:<{tw}s} {:>3s} {:>4s} {:>3s} {:>3s} {:>4s} {:>3s} {:>3s} {:>3s}".format(
                pos, team, played, pts, gf, ga, gd, w, d, l, tw=tw))


def validate_arguments(arguments):
    if arguments['--deadline']:
        deadline_value = arguments['--deadline']

        if not re.match(DEADLINE_REGEX, deadline_value):
            exit("Invalid deadline value ({}), use <Number><Unit>, Unit=[m,h,d]".format(
                deadline_value))


def choose_predictor(predictor_param, predictors):
    if(predictor_param):
        if(predictor_param in predictors):
            predictor = predictors[predictor_param]()
        else:
            exit('Unknown predictor: {}'.format(predictor_param))
    else:
        # Just get the first predictor in the dict and instanciate it
        predictor = next(iter(predictors.values()))()
    print("Using predictor: "+type(predictor).__name__)
    return predictor


def main(arguments):
    validate_arguments(arguments)
    predictors_ = predictors.base.get_predictors()

    # Just list the predictors at hand and exit
    if arguments['--list-predictors']:
        [print(key) for key in predictors_.keys()]
        exit(0)

    # Logout: remove credentials and session
    if arguments['--logout']:
        logout()
        exit(0)

    # Load or prompt for credentials
    email, password = load_credentials()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # Try restoring a saved session
        page = None
        if os.path.exists(SESSION_FILE):
            status("Restoring session...")
            context = browser.new_context(viewport={'width': 1280, 'height': 900}, storage_state=SESSION_FILE)
            page = context.new_page()
            page.goto(URL_BASE)
            page.wait_for_load_state('domcontentloaded')
            if '/login' in page.url:
                status("Session expired, logging in again...")
                context.close()
                page = None

        # Fresh login if no valid session
        if page is None:
            context = browser.new_context(viewport={'width': 1280, 'height': 900})
            page = context.new_page()
            login(page, email, password)
            os.makedirs(CONFIG_DIR, exist_ok=True)
            context.storage_state(path=SESSION_FILE)

        # List all communities and exit
        if arguments['--list-communities']:
            all_communities = get_communities(page, [])
            status_clear()
            for com in all_communities:
                print(com)
            browser.close()
            exit(0)

        # Select and save a default community
        if arguments['--set-community']:
            set_community(page)
            browser.close()
            exit(0)

        # List players
        if arguments['--list-players']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            players = get_players(page, community)
            for name in players:
                print(name)
            browser.close()
            exit(0)

        # Set player
        if arguments['--set-player']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            set_player(page, community)
            browser.close()
            exit(0)

        # Show bets
        if arguments['--bets']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            show_bets(page, community, matchday=arguments['--matchday'])
            browser.close()
            exit(0)

        # Auto-place bets using predictor
        if arguments['--auto-bets']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            predictor_param = arguments['--predictor'] if '--predictor' in arguments else None
            predictor = choose_predictor(predictor_param, predictors_)
            place_bets(page, [community], predictor,
                       override=arguments['--override-bets'],
                       deadline=arguments['--deadline'],
                       dryrun=arguments['--dry-run'],
                       matchday=arguments['--matchday'])
            browser.close()
            exit(0)

        # Bulk set all bets
        if arguments['--set-all-bets']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            set_all_bets(page, community, arguments['--set-all-bets'], matchday=arguments['--matchday'])
            browser.close()
            exit(0)

        # Manually set bets
        if arguments['--set-bets']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            set_bets(page, community, matchday=arguments['--matchday'])
            browser.close()
            exit(0)

        # Show rules
        if arguments['--rules']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            show_rules(page, community)
            browser.close()
            exit(0)

        # Show schedule
        if arguments['--schedule']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            show_schedule(page, community, matchday=arguments['--matchday'])
            browser.close()
            exit(0)

        # Show league table
        if arguments['--table']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            option = None
            if arguments['--home']:
                option = 'heim'
            elif arguments['--away']:
                option = 'gast'
            show_table(page, community, option=option)
            browser.close()
            exit(0)

        # Show overview
        if arguments['--overview']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            view = arguments['--view'] or 'matchday-points'
            show_overview(page, community, view=view)
            browser.close()
            exit(0)

        # Show leaderboard
        if arguments['--leaderboard']:
            community = load_community()
            if not community:
                set_community(page)
                community = load_community()
            show_leaderboard(page, community, matchday=arguments['--matchday'], bonus=arguments['--bonus'])
            browser.close()
            exit(0)

        communities = arguments['COMMUNITY']

        # Use saved community if none specified on command line
        if not communities:
            saved = load_community()
            if saved:
                communities = [saved]
            else:
                set_community(page)
                communities = [load_community()]

        # Which communities are considered, fail if no were found
        communities = get_communities(page, communities)
        if(len(communities) == 0):
            browser.close()
            exit("No community found!?")

        # Which prediction method is used
        status_clear()
        predictor_param = arguments['--predictor'] if '--predictor' in arguments else None
        predictor = choose_predictor(predictor_param, predictors_)

        # Place bets
        place_bets(page, communities, predictor,
                   override=arguments['--override-bets'], deadline=arguments['--deadline'], dryrun=arguments['--dry-run'], matchday=arguments['--matchday'])

        browser.close()


if __name__ == '__main__':
    arguments = docopt(__doc__, version='KickTipp BetBot 1.0')
    main(arguments)
