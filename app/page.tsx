import { redirect } from "next/navigation";
import AppShell from "@/components/AppShell";
import { auth } from "@/auth";
import type { Role } from "@/utils/roles";

export default async function Page() {
  // Server-side dev bypass: skip Google OAuth when DEV_ADMIN_EMAIL is set locally.
  // process.env is available in server components; this never reaches the client bundle.
  if (process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_EMAIL) {
    return <AppShell devRole="admin" />;
  }

  // Stakeholder occupancy-only accounts have no reporting-app tabs — send them
  // straight to their standalone page instead of an empty shell.
  const session = await auth();
  const role = (session?.user as { role?: Role } | undefined)?.role;
  if (role === 'occupancy') redirect('/occupancy');

  return <AppShell />;
}
