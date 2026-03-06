import re
import subprocess

from helper.match import Match
from .base import PredictorBase

PROMPT_TEMPLATE = (
    'Predict the score for: {home} vs {away} '
    '(odds: {rate_home}/{rate_deuce}/{rate_road}). '
    'Reply with only the score in H:G format, nothing else.'
)


class ClaudePredictor(PredictorBase):

    def predict(self, match: Match):
        prompt = PROMPT_TEMPLATE.format(
            home=match.hometeam,
            away=match.roadteam,
            rate_home=match.rate_home,
            rate_deuce=match.rate_deuce,
            rate_road=match.rate_road,
        )

        try:
            result = subprocess.run(
                ['claude', '-p', prompt, '--output-format', 'text'],
                capture_output=True, text=True, timeout=30,
            )
        except FileNotFoundError:
            exit('Error: Claude Code CLI not found. Install it from https://claude.ai/code')

        if result.returncode != 0:
            exit('Error: Claude CLI failed: {}'.format(result.stderr.strip()))

        score_match = re.search(r'(\d+):(\d+)', result.stdout)
        if not score_match:
            exit('Error: Could not parse Claude\'s response: "{}"'.format(result.stdout.strip()))

        return (int(score_match.group(1)), int(score_match.group(2)))
