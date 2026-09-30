import { redirect } from "next/navigation";

/** T0：根路径先跳到 /today；登录保护在 T1 加入 */
export default function Home() {
  redirect("/today");
}
