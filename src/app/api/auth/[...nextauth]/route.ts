// NextAuth v5 (Auth.js) route. Google provider, token encryption, refresh flow,
// and multi-account linking all live in src/lib/auth.ts.
import { handlers } from "@/lib/auth";
export const { GET, POST } = handlers;
