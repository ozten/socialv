/** One thing shown to the owner on a gate's review page. */
export interface GateItem {
  /** The item's number in the packet, from 1. `approve 1,3` refers to these. */
  n: number;
  label: string;
  /** Text shown as is. */
  text?: string;
  /** A file relative to the run folder, shown inline by type: image, video, audio, JSON or text. */
  file?: string;
  /** Small facts shown beside the item, such as cost or digest. */
  meta?: Record<string, string>;
}

/** What a gate's review page shows. */
export interface GatePage {
  run: string;
  /** A short id for the gate, unique in the run, safe in a file name: `review-1`. */
  gate: string;
  title: string;
  summary: string;
  items: GateItem[];
  /** The board thread to reply in. */
  threadId: string;
}
