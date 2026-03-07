import { execFileSync } from 'child_process';
import { Match } from '../helpers/match.js';
import { Predictor } from './base.js';

export class ClaudePredictor implements Predictor {
  predict(match: Match): [number, number] {
    const prompt =
      `Predict the score for: ${match.hometeam} vs ${match.roadteam} ` +
      `(odds: ${match.rateHome}/${match.rateDeuce}/${match.rateRoad}). ` +
      `Reply with only the score in H:G format, nothing else.`;

    let stdout: string;
    try {
      stdout = execFileSync('claude', ['-p', prompt, '--output-format', 'text'], {
        encoding: 'utf-8',
        timeout: 30000,
      });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        console.error('Error: Claude Code CLI not found. Install it from https://claude.ai/code');
        process.exit(1);
      }
      console.error(`Error: Claude CLI failed: ${err.stderr || err.message}`);
      process.exit(1);
    }

    const scoreMatch = stdout.match(/(\d+):(\d+)/);
    if (!scoreMatch) {
      console.error(`Error: Could not parse Claude's response: "${stdout.trim()}"`);
      process.exit(1);
    }

    return [parseInt(scoreMatch[1]), parseInt(scoreMatch[2])];
  }
}
