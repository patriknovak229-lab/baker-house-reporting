import AppShell from "@/components/AppShell";
import type { Role } from "@/utils/roles";

export default function Page() {
  // Server-side dev bypass: skip Google OAuth when DEV_ADMIN_EMAIL is set locally.
  // process.env is available in server components; this never reaches the client bundle.
  const devRole: Role | undefined =
    process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_EMAIL
      ? 'admin'
      : undefined;

  return <AppShell devRole={devRole} />;
}
