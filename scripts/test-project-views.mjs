import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readdir, writeFile, access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const cwd=process.cwd(), port=Number(process.env.PROJECT_VIEWS_PORT || 1431);
const output=path.join(cwd,".artifacts/project-views",new Date().toISOString().replace(/[:.]/g,"-"));
await mkdir(output,{recursive:true});
const report={port,output,checks:[],console:[],pageErrors:[],screenshots:[],cleanup:false};
let server,browser;
try {
  await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once("error",reject);probe.listen(port,"127.0.0.1",()=>probe.close(resolve));});
  const modules=await readdir(path.join(cwd,"node_modules/.pnpm"));
  const installed=modules.find(name=>name.startsWith("playwright-core@"));
  assert(installed,"Existing playwright-core dependency required; no installation attempted");
  const {chromium}=await import(pathToFileURL(path.join(cwd,"node_modules/.pnpm",installed,"node_modules/playwright-core/index.mjs")).href);
  const executable=process.env.PROJECT_VIEWS_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe";
  await access(executable);
  server=spawn(process.execPath,["node_modules/vite/bin/vite.js","--host","127.0.0.1","--port",String(port),"--strictPort"],{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  report.serverPid=server.pid;
  let serverLog="";server.stdout.on("data",d=>serverLog+=d);server.stderr.on("data",d=>serverLog+=d);
  const url=`http://127.0.0.1:${port}/tests/browser/project-views.html`;
  for(let attempt=0;attempt<120;attempt++){try{if((await fetch(url)).ok)break;}catch{}if(attempt===119)throw new Error("Vite failed: "+serverLog);await new Promise(r=>setTimeout(r,250));}
  browser=await chromium.launch({headless:true,executablePath:executable});
  for(const [name,width,height] of [["desktop",1280,1000],["narrow",380,1000]]) {
    const page=await browser.newPage({viewport:{width,height}});
    page.on("console",msg=>{if(msg.type()==="error"||msg.type()==="warning")report.console.push({name,type:msg.type(),text:msg.text(),location:msg.location()});});
    page.on("pageerror",error=>report.pageErrors.push({name,error:String(error)}));
    page.setDefaultTimeout(60_000);
    await page.goto(url,{waitUntil:"domcontentloaded",timeout:60_000});
    const settings=page.getByTestId("project-settings"),sidebar=page.getByTestId("project-sidebar"),files=page.getByTestId("project-files"),preview=page.getByTestId("external-image");
    await settings.getByRole("button",{name:"Create project",exact:true}).waitFor();
    await sidebar.getByRole("button",{name:"Sample project",exact:true}).waitFor();
    await sidebar.getByRole("button",{name:"Other workspace",exact:true}).waitFor();
    assert.equal(await sidebar.getByRole("combobox").count(),0);
    assert.equal(await sidebar.getByRole("button",{name:"All workspaces"}).count(),0);
    await files.getByText("Game root",{exact:true}).waitFor();
    await files.getByText("Research reference",{exact:true}).waitFor();
    assert.equal(await files.getByText("Nested planning",{exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.projectFixture.snapshot().roots.length),2);
    assert.equal(await page.evaluate(()=>window.projectFixture.launches.length),0);
    await sidebar.getByRole("button",{name:"New session · Sample project",exact:true}).click();
    const memberRow=sidebar.getByRole("button",{name:"Nested planning",exact:true}).locator("..");
    await memberRow.hover();
    await memberRow.getByRole("button",{name:"New session",exact:true}).click();
    await page.waitForFunction(()=>window.projectFixture.launches.length===2);
    assert.deepEqual(await page.evaluate(()=>window.projectFixture.launches),["C:/fixture/game","C:/fixture/game/plan"]);
    assert.equal(await page.evaluate(()=>window.projectFixture.snapshot().active.sessionId),"original");
    await sidebar.getByRole("button",{name:"Sample project",exact:true}).click();
    await sidebar.getByRole("button",{name:"Nested planning",exact:true}).waitFor({state:"hidden"});
    await sidebar.getByRole("button",{name:"Other workspace",exact:true}).waitFor();
    await sidebar.getByRole("button",{name:"Sample project",exact:true}).click();
    await sidebar.getByRole("button",{name:"Nested planning",exact:true}).waitFor();
    const listShot=path.join(output,`${name}-workspace-list.png`);await sidebar.screenshot({path:listShot});report.screenshots.push(listShot);
    report.checks.push(`${name}: inline project collection, unrelated workspace retained, no global selector or preset role labels, exact default/member launch, active session preserved`);
    await settings.getByRole("button",{name:"Create project",exact:true}).click();
    await settings.getByRole("textbox",{name:"Project name"}).fill("Browser created project");
    await settings.getByRole("button",{name:"Choose directory",exact:true}).click();
    await settings.getByRole("textbox",{name:"Display name"}).fill("New member");
    await page.evaluate(()=>window.projectFixture.failNextSave());
    await settings.getByRole("button",{name:"Save",exact:true}).click();
    await settings.getByRole("alert").filter({hasText:"Synthetic save failure"}).waitFor();
    assert.equal(await settings.getByRole("textbox",{name:"Project name"}).inputValue(),"Browser created project");
    assert.equal(await settings.getByRole("textbox",{name:"Display name"}).inputValue(),"New member");
    const draftOverflow=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
    report.checks.push({name,draftOverflow});assert(draftOverflow.width<=width+1&&draftOverflow.body<=width+1,`${name}: draft horizontal overflow ${JSON.stringify(draftOverflow)}`);
    const draftShot=path.join(output,`${name}-draft.png`);await page.screenshot({path:draftShot,fullPage:true});report.screenshots.push(draftShot);
    await settings.getByRole("button",{name:"Save",exact:true}).click();
    await page.waitForFunction(()=>window.projectFixture.snapshot().projects.some(p=>p.id==="created"));
    const row=settings.locator("div").filter({has:page.getByText("Browser created project",{exact:true})}).filter({has:page.getByRole("button",{name:"Edit project",exact:true})}).last();
    await row.getByRole("button",{name:"Edit project",exact:true}).click();
    await settings.getByRole("textbox",{name:"Project name"}).fill("Browser edited project");
    await settings.getByRole("button",{name:"Save",exact:true}).click();
    await settings.getByText("Browser edited project",{exact:true}).waitFor();
    const edited=settings.locator("div").filter({has:page.getByText("Browser edited project",{exact:true})}).filter({has:page.getByRole("button",{name:"Remove project",exact:true})}).last();
    await edited.getByRole("button",{name:"Remove project",exact:true}).click();
    await page.getByRole("dialog").getByRole("button",{name:/Confirm|Remove|Delete/}).click();
    await page.waitForFunction(()=>!window.projectFixture.snapshot().projects.some(p=>p.id==="created"));
    assert.equal(await page.evaluate(()=>window.projectFixture.calls.some(c=>c.command==="remove_workspace")),false);
    report.checks.push(`${name}: create/edit, failed save preserves draft, removal only changes relationship`);
    await preview.getByRole("button",{name:"Preview only this image",exact:true}).click();
    await preview.getByRole("img",{name:"external preview"}).waitFor();
    assert.equal(await page.evaluate(()=>window.projectFixture.calls.some(c=>c.command==="grant_root")),false);
    const grants=await page.evaluate(()=>window.projectFixture.calls.filter(c=>c.command==="grant_image_preview"));
    assert.equal(grants.length,1);assert.equal(grants[0].args.scope,"file");assert.equal(grants[0].args.expectedPath,grants[0].args.path);
    const imageShot=path.join(output,`${name}-image.png`);await page.screenshot({path:imageShot,fullPage:true});report.screenshots.push(imageShot);
    await preview.getByRole("button",{name:"Preview external preview",exact:true}).click();
    const lightbox=page.getByRole("dialog",{name:"external preview",exact:true});
    await lightbox.getByRole("img",{name:"external preview"}).waitFor();
    await page.evaluate(()=>window.projectFixture.revoke());
    await lightbox.getByRole("button",{name:"Preview only this image",exact:true}).waitFor();
    assert.equal(await lightbox.getByRole("img").count(),0);
    await page.keyboard.press("Escape");
    await preview.getByRole("button",{name:"Preview only this image",exact:true}).waitFor();
    assert.equal(await preview.getByRole("img").count(),0);
    report.checks.push(`${name}: file-only inline grant, no grant_root, revocation removes thumbnail and open lightbox image`);
    const overflow=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
    report.checks.push({name,overflow});assert(overflow.width<=width+1&&overflow.body<=width+1,`${name}: horizontal overflow ${JSON.stringify(overflow)}`);
    await page.close();
  }
  assert.equal(report.pageErrors.length,0,JSON.stringify(report.pageErrors));
  assert.equal(report.console.length,0,JSON.stringify(report.console));
  report.passed=true;
} catch(error) {report.passed=false;report.failure=String(error.stack||error);process.exitCode=1;}
finally {
  if(!report.passed && browser) for(const context of browser.contexts()) for(const page of context.pages()) {
    const failureShot=path.join(output,"failure.png");await page.screenshot({path:failureShot,fullPage:true}).catch(()=>{});report.screenshots.push(failureShot);
    report.failureText=await page.locator("body").innerText().catch(()=>"");
  }
  await browser?.close();
  if(server?.pid) {
    if(process.platform==="win32") await new Promise(resolve=>{const stop=spawn("taskkill",["/PID",String(server.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});stop.once("exit",resolve);});
    else server.kill("SIGTERM");
    for(let attempt=0;attempt<30;attempt++){try{process.kill(server.pid,0);}catch{report.cleanup=true;break;}await new Promise(r=>setTimeout(r,100));}
  }
  await writeFile(path.join(output,"report.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
