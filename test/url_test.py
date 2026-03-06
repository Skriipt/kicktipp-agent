
import pytest
from bs4 import BeautifulSoup
import kicktippbb

def test_predict_url_wo_matchday():
    actualUrl = kicktippbb.get_predict_url('mycomm')
    assert actualUrl == 'https://www.kicktipp.com/mycomm/predict'

def test_predict_url_with_matchday():
    actualUrl = kicktippbb.get_predict_url('mycomm', 5)
    assert actualUrl == 'https://www.kicktipp.com/mycomm/predict?spieltagIndex=5'

def test_predict_url_matchday_oob():
    with pytest.raises(IndexError):
        kicktippbb.get_predict_url('mycomm', 42)
    with pytest.raises(IndexError):
        kicktippbb.get_predict_url('mycomm', 0)

def test_parse_odds():
    html = '<td><div class="tippabgabe-quoten"><span class="quote quote-heim"><span class="quote-label">1</span><span class="quote-text">1.03</span></span><span class="quote quote-remis"><span class="quote-label">X</span><span class="quote-text">77.4</span></span><span class="quote quote-gast"><span class="quote-label">2</span><span class="quote-text">59.8</span></span></div></td>'
    td = BeautifulSoup(html, 'html.parser').find('td')
    assert kicktippbb.parse_odds(td) == ('1.03', '77.4', '59.8')


def test_parse_bet_arg_valid():
    home, away, h, g = kicktippbb.parse_bet_arg("FC Bayern München vs Borussia Dortmund=2:1")
    assert home == "FC Bayern München"
    assert away == "Borussia Dortmund"
    assert h == 2
    assert g == 1


def test_parse_bet_arg_zero_zero():
    home, away, h, g = kicktippbb.parse_bet_arg("Leipzig vs Leverkusen=0:0")
    assert home == "Leipzig"
    assert away == "Leverkusen"
    assert h == 0
    assert g == 0


def test_parse_bet_arg_missing_vs():
    with pytest.raises(SystemExit):
        kicktippbb.parse_bet_arg("FC Bayern - Dortmund=2:1")


def test_parse_bet_arg_missing_equals():
    with pytest.raises(SystemExit):
        kicktippbb.parse_bet_arg("FC Bayern vs Dortmund 2:1")


def test_parse_bet_arg_invalid_result():
    with pytest.raises(SystemExit):
        kicktippbb.parse_bet_arg("FC Bayern vs Dortmund=abc")


def test_parse_bet_arg_equals_in_no_result():
    with pytest.raises(SystemExit):
        kicktippbb.parse_bet_arg("FC Bayern vs Dortmund=")


def test_match_fixture_exact():
    editable = [
        ("FC Bayern München", "Borussia Dortmund", "heim1", "gast1"),
        ("RB Leipzig", "Bayer 04 Leverkusen", "heim2", "gast2"),
    ]
    result = kicktippbb.match_fixture("FC Bayern München", "Borussia Dortmund", editable)
    assert result == ("FC Bayern München", "Borussia Dortmund", "heim1", "gast1")


def test_match_fixture_case_insensitive():
    editable = [
        ("FC Bayern München", "Borussia Dortmund", "heim1", "gast1"),
    ]
    result = kicktippbb.match_fixture("fc bayern münchen", "borussia dortmund", editable)
    assert result == ("FC Bayern München", "Borussia Dortmund", "heim1", "gast1")


def test_match_fixture_not_found():
    editable = [
        ("FC Bayern München", "Borussia Dortmund", "heim1", "gast1"),
    ]
    with pytest.raises(SystemExit):
        kicktippbb.match_fixture("Unknown FC", "Borussia Dortmund", editable)
