import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/server/auth";

const handler = () => toNextJsHandler(auth());
export const GET = (req: Request) => handler().GET(req);
export const POST = (req: Request) => handler().POST(req);
