/** 线上 P2 冒烟核对：课程语义模型/投影/实践/journal 落库情况（只读） */
import { getDb } from "/app/src/repositories/db";

const db = getDb();
console.log("semesters:", JSON.stringify(db.prepare("SELECT first_monday, total_weeks FROM semesters").all()));
console.log("courses:", JSON.stringify(db.prepare("SELECT name FROM courses").all()));
console.log("projections:", JSON.stringify(db.prepare("SELECT COUNT(*) AS n FROM course_meeting_projections").get()));
console.log("fixed_events:", JSON.stringify(db.prepare("SELECT title, weekday, local_start FROM fixed_events WHERE title LIKE '%smoke%'").all()));
console.log("practice:", JSON.stringify(db.prepare("SELECT occurred_on, actual_minutes, minutes_origin FROM practice_entries").all()));
console.log("batches:", JSON.stringify(db.prepare("SELECT command, status FROM agent_action_batches").all()));
