/** 线上 P2 冒烟：容器内建临时会话 → 走真实 HTTP 全流程。只读会话创建，不碰密码。 */
import { createSession } from "../../src/domain/session";

const { token, session } = createSession(1);
console.log(JSON.stringify({ token, csrf: session.csrfToken }));
