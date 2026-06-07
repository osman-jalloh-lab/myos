// NextAuth v5 (Auth.js) route. TODO Stage 3: wire Google provider with server-side OAuth
// and multi-account linking (see src/lib/auth.ts and docs/DEPLOY_TO_VERCEL.md section 2).
import { handlers } from "@/lib/auth";
export const { GET, POST } = handlers;
