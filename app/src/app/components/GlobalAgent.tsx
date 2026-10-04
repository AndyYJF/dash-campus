"use client";

import { usePathname } from "next/navigation";
import UniversalIntake from "./UniversalIntake";

const WORKSPACES = new Set(["today", "week", "direction", "settings", "inbox", "projects", "explore", "reviews", "plan", "notifications"]);

/** Root-layout mount: same composer and in-memory draft survive workbench navigation. */
export default function GlobalAgent() {
  const pathname = usePathname();
  return WORKSPACES.has(pathname.split("/")[1] ?? "") ? <UniversalIntake /> : null;
}
