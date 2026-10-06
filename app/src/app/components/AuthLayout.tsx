import type { ReactNode } from "react";
import auth from "./auth.module.css";
import BrandMark from "./BrandMark";
import Icon from "./Icon";

/** 登录与初始化页共用的版式：左侧品牌面板（窄屏隐藏），右侧标题 + 表单 + 一行说明。 */
export default function AuthLayout({
  title,
  lead,
  foot,
  children,
}: {
  title: string;
  lead: string;
  foot: string;
  children: ReactNode;
}) {
  return (
    <main className={auth.wrap}>
      <div className={auth.aside} aria-hidden="true">
        <div className={auth.brand}>
          <BrandMark />
          Dash Campus
        </div>
        <div>
          <p className={auth.tagline}>
            计划今天，
            <br />
            记下每一步。
          </p>
          <ul className={auth.points}>
            <li>一周只定一个重点</li>
            <li>负担放不放得下，一眼看清</li>
            <li>进展与卡点，随手记下</li>
          </ul>
        </div>
        <div className={auth.asideFoot}>自部署，只有你一个用户</div>
      </div>
      <div className={auth.formSide}>
        <div className={auth.panel}>
          <div className={auth.mobileBrand}>
            <BrandMark />
            Dash Campus
          </div>
          <h1>{title}</h1>
          <p className={auth.lead}>{lead}</p>
          {children}
        </div>
        <p className={auth.foot}>
          <Icon name="lock" size={14} />
          {foot}
        </p>
      </div>
    </main>
  );
}
