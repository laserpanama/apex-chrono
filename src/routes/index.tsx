import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/timer/AppShell";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <AppShell />;
}
