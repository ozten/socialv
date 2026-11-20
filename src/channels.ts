// Channel layout. The kind of channel comes first and the run second, so that
// prefix grants (`work/`, `gates/`) cover every run on a network board later.

export const INTAKE = "intake";
export const OPS = "ops";

/** Stage tasks, and the conversations in their threads. */
export const workChannel = (run: string) => `work/${run}`;
/** Approval gates. Only the conductor and the owner post here. */
export const gatesChannel = (run: string) => `gates/${run}`;
/** Paid requests. Only the gateway claims here. */
export const spendChannel = (run: string) => `spend/${run}`;
/** Progress and cost digest. */
export const statusChannel = (run: string) => `status/${run}`;

/** Board profiles of the processes that are not roles. */
export const CONDUCTOR = "conductor";
export const GATEWAY = "gateway";
