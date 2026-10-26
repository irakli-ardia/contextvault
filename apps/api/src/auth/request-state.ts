import { type Actor, type Identity, Unauthenticated } from "@contextvault/domain";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

// Identity and actor are bound only by SessionGuard and WorkspaceGuard, from database rows. They
// live in side tables keyed by the request object, so no header, body, or query value can reach
// them, and nothing else in the app can construct one for a request.
const identities = new WeakMap<object, Identity>();
const actors = new WeakMap<object, Actor>();
const requestIds = new WeakMap<object, string>();

export const bindIdentity = (req: object, identity: Identity): void => {
  identities.set(req, identity);
};
export const bindActor = (req: object, actor: Actor): void => {
  actors.set(req, actor);
};
export const bindRequestId = (req: object, id: string): void => {
  requestIds.set(req, id);
};
export const requestIdOf = (req: object): string => requestIds.get(req) ?? "unknown";
export const identityOf = (req: object): Identity | undefined => identities.get(req);
const actorOf = (req: object): Actor | undefined => actors.get(req);

export const CurrentIdentity = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const identity = identityOf(ctx.switchToHttp().getRequest<object>());
  if (identity === undefined) throw new Unauthenticated();
  return identity;
});

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const actor = actorOf(ctx.switchToHttp().getRequest<object>());
  if (actor === undefined) throw new Unauthenticated();
  return actor;
});
