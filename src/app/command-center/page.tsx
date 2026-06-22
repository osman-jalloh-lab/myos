import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import CommandCenterClient from "./CommandCenterClient";

export const metadata = {
  title: "Agent Control Center — Hermes OS",
};

export default async function CommandCenterPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/auth/signin");
  return <CommandCenterClient />;
}
