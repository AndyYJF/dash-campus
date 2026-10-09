import AppShell from "@/app/components/AppShell";
import styles from "./page.module.css";

/** The root GlobalAgent shares the workbench draft and renders the full-page conversation. */
export default function ChatPage() {
  return <AppShell currentPath="/chat"><h1 className={styles.heading}>Agent 对话</h1></AppShell>;
}
