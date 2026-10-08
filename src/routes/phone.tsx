import { createFileRoute } from "@tanstack/react-router";
import { PhoneScreen } from "@/components/phone/PhoneScreen";

export const Route = createFileRoute("/phone")({
  component: PhoneScreen,
  ssr: false,
});
