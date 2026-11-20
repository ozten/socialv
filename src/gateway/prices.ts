// What each paid endpoint costs. The gateway refuses an endpoint it cannot
// price. Prices are estimates for the caps; fal does not return a per-request
// cost in its result, so the estimate is also what the ledger records.

/** What a request to an endpoint will cost: the expected amount and the most it can be. */
export interface Estimate {
  estimated_usd: number;
  max_cost_usd: number;
}

/** What a price needs to know about a request. */
export interface PriceBasis {
  /** Seconds of audio, for per-minute endpoints. */
  audio_sec?: number;
}

interface Price {
  /** Human-readable rate, for messages. */
  rate: string;
  estimate(basis: PriceBasis): Estimate;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

function perAudioMinute(usdPerMinute: number): Price {
  return {
    rate: `$${usdPerMinute}/audio minute`,
    estimate({ audio_sec }) {
      if (audio_sec === undefined || !(audio_sec >= 0)) {
        throw new UnpricedError("a per-minute price needs the audio duration");
      }
      const minutes = audio_sec / 60;
      // Billing granularity is not documented: the ceiling assumes whole minutes, rounded up.
      return { estimated_usd: round(minutes * usdPerMinute), max_cost_usd: round(Math.max(1, Math.ceil(minutes)) * usdPerMinute) };
    },
  };
}

export const SPEECH_TO_TEXT = "fal-ai/elevenlabs/speech-to-text";

const PRICES: Record<string, Price> = {
  // https://fal.ai/models/fal-ai/elevenlabs/speech-to-text/llms.txt, read 2026-11-20:
  // "Price: $0.03 per minutes". Another source said $0.008/min; the live page settles it.
  [SPEECH_TO_TEXT]: perAudioMinute(0.03),
};

export class UnpricedError extends Error {}

/** The estimate for a request to `endpoint`. Throws UnpricedError for an endpoint not in the table. */
export function estimate(endpoint: string, basis: PriceBasis): Estimate {
  const price = PRICES[endpoint];
  if (!price) {
    throw new UnpricedError(`the gateway has no price for endpoint ${endpoint}, so it will not call it`);
  }
  return price.estimate(basis);
}

export function rateOf(endpoint: string): string | undefined {
  return PRICES[endpoint]?.rate;
}
