// Channel layout, named for the production workflow. The kind of channel comes
// first and the run second, so that prefix grants (`production/`,
// `approvals/`) cover every run on a network board.

/** Requests to start a run. */
export const INTAKE = "intake";
/** Failures and budget stops that need the owner. */
export const ALERTS = "alerts";

/** Prefix of the channels holding a run's work. */
export const PRODUCTION = "production/";
/** Prefix of the channels holding paid requests. */
export const SPEND = "spend/";

/** One thread per piece of work, with the agents' questions and answers. */
export const workChannel = (run: string) => `${PRODUCTION}${run}`;
/** One thread per decision that needs the owner. Only the conductor and the owner post here. */
export const gatesChannel = (run: string) => `approvals/${run}`;
/** One thread per paid request. Only the gateway claims here. */
export const spendChannel = (run: string) => `${SPEND}${run}`;
/** Run milestones and cost so far. */
export const statusChannel = (run: string) => `progress/${run}`;

/** Board profiles of the processes that are not roles. */
export const CONDUCTOR = "conductor";
export const GATEWAY = "gateway";
