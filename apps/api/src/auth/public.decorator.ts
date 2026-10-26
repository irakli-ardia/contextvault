import { SetMetadata } from "@nestjs/common";

export const isPublicKey = "isPublic";
/** Opts a route out of SessionGuard. Default deny: every other route needs a live session. */
export const Public = () => SetMetadata(isPublicKey, true);
