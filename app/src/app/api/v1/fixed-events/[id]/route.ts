import { NextRequest } from "next/server";
import { PATCH as patchCalendar, DELETE as deleteCalendar } from "../../availability/[id]/route";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string}>};
async function fixedRequest(request:NextRequest) {
  const url=new URL(request.url);url.searchParams.set("kind","fixed-event");
  return new NextRequest(url,{method:request.method,headers:request.headers,body:await request.text()});
}
export async function PATCH(request:NextRequest,ctx:Context){return patchCalendar(await fixedRequest(request),ctx);}
export async function DELETE(request:NextRequest,ctx:Context){return deleteCalendar(await fixedRequest(request),ctx);}
