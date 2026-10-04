"use client";

import type { ReactNode } from "react";
import { compose } from "./dashBus";

export default function AgentLauncher({ className, children }: { className: string; children: ReactNode }) {
  return <button type="button" className={className} onClick={() => compose({ label: "" })}>{children}</button>;
}
