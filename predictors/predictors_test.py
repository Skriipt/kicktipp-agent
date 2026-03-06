from . import base


def test_scanpreditors():
    subpackages = base.explore_package()
    assert len(subpackages) > 0
    pass


def test_instanciatepreditors():
    predictors = base.get_predictors()
    assert 'SimplePredictor' in predictors.keys()
    predictorobj = predictors['SimplePredictor']()
    assert issubclass(type(predictorobj), base.PredictorBase)
    pass


from unittest.mock import patch, MagicMock
import subprocess


def test_claude_predictor_discovery():
    predictors = base.get_predictors()
    assert 'ClaudePredictor' in predictors.keys()


def test_claude_predictor_parses_response():
    from predictors.claudepredictor import ClaudePredictor
    from helper.match import Match

    predictor = ClaudePredictor()
    match = Match("FC Bayern", "Dortmund", "03/15/26 03:30 PM", "1.5", "4.2", "6.1")

    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "2:1\n"

    with patch('subprocess.run', return_value=mock_result) as mock_run:
        home, road = predictor.predict(match)
        assert home == 2
        assert road == 1
        mock_run.assert_called_once()
        call_args = mock_run.call_args
        assert call_args[0][0][0] == 'claude'
        assert '-p' in call_args[0][0]


def test_claude_predictor_handles_verbose_response():
    from predictors.claudepredictor import ClaudePredictor
    from helper.match import Match

    predictor = ClaudePredictor()
    match = Match("FC Bayern", "Dortmund", "03/15/26 03:30 PM", "1.5", "4.2", "6.1")

    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "Based on the odds, I predict 3:0 for Bayern."

    with patch('subprocess.run', return_value=mock_result):
        home, road = predictor.predict(match)
        assert home == 3
        assert road == 0


def test_claude_predictor_unparseable_response():
    from predictors.claudepredictor import ClaudePredictor
    from helper.match import Match

    predictor = ClaudePredictor()
    match = Match("FC Bayern", "Dortmund", "03/15/26 03:30 PM", "1.5", "4.2", "6.1")

    mock_result = MagicMock()
    mock_result.returncode = 0
    mock_result.stdout = "I'm not sure about this match."

    with patch('subprocess.run', return_value=mock_result):
        import pytest
        with pytest.raises(SystemExit):
            predictor.predict(match)


def test_claude_predictor_cli_not_found():
    from predictors.claudepredictor import ClaudePredictor
    from helper.match import Match

    predictor = ClaudePredictor()
    match = Match("FC Bayern", "Dortmund", "03/15/26 03:30 PM", "1.5", "4.2", "6.1")

    with patch('subprocess.run', side_effect=FileNotFoundError()):
        import pytest
        with pytest.raises(SystemExit):
            predictor.predict(match)


def test_claude_predictor_cli_failure():
    from predictors.claudepredictor import ClaudePredictor
    from helper.match import Match

    predictor = ClaudePredictor()
    match = Match("FC Bayern", "Dortmund", "03/15/26 03:30 PM", "1.5", "4.2", "6.1")

    mock_result = MagicMock()
    mock_result.returncode = 1
    mock_result.stderr = "Some error"

    with patch('subprocess.run', return_value=mock_result):
        import pytest
        with pytest.raises(SystemExit):
            predictor.predict(match)
