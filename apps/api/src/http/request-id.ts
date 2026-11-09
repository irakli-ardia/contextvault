// The request id is minted by `responseHeaders` and read by the error filter and controllers. It
// lives in a side table keyed by the request object, so no header, body, or query value can set it.
const requestIds = new WeakMap<object, string>();

export const bindRequestId = (req: object, id: string): void => {
  requestIds.set(req, id);
};
export const requestIdOf = (req: object): string => requestIds.get(req) ?? "unknown";
