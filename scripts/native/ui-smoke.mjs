import assert from 'node:assert/strict';import {readFile,writeFile,mkdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {resolve,relative,isAbsolute,join} from 'node:path';import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../',import.meta.url)),run=resolve(process.argv[2]??''),local=relative(join(root,'.runtime'),run);
if(!process.argv[2]||isAbsolute(local)||local.startsWith('..'))throw Error('UI smoke must use an owned .runtime directory');
const read=async file=>JSON.parse((await readFile(join(run,file),'utf8')).replace(/^\uFEFF/u,'')),info=await read('run-info.json'),start=await read('clean-start.json'),origin=`http://127.0.0.1:${info.port}`,log=await readFile(join(run,'host.stdout.log'),'utf8'),url=log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u)?.[0];
assert.ok(url?.startsWith(`${origin}/?token=`));
const browserPath=process.env.GM_NATIVE_BROWSER_PATH??'C:/Users/Owner/AppData/Local/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-win64/chrome-headless-shell.exe';
const browser=await chromium.launch({headless:true,executablePath:browserPath,args:['--disable-extensions']}),context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}),page=await context.newPage(),errors=[];
page.on('pageerror',error=>errors.push({kind:'pageerror',message:error.message}));page.on('console',message=>{if(message.type()==='error')errors.push({kind:'console',message:message.text()});});
const images=join(root,'docs/images');await mkdir(images,{recursive:true});
try{
  await page.goto(url,{waitUntil:'domcontentloaded'});await page.getByRole('tree',{name:'会话',exact:true}).waitFor();
  const preview=page.getByRole('dialog',{name:'预览版说明',exact:true});try{await preview.getByRole('button',{name:'继续',exact:true}).click({timeout:1500});}catch(error){if(error.name!=='TimeoutError')throw error;}await preview.waitFor({state:'hidden'});
  const group=page.getByRole('treeitem',{name:/^未分组/}).first();if(await group.getAttribute('aria-expanded')!=='true')await group.click();await page.locator(`[data-row-key="session:${start.sessionId}"]`).click();
  await page.getByRole('button',{name:'打开 RP 最后一步',exact:true}).click();await page.getByRole('button',{name:'生成记录',exact:true}).click();await page.getByText('当前分支正式正文',{exact:true}).waitFor();
  await page.getByText(start.binding.opening.text,{exact:true}).waitFor();await page.getByText('林遥接过密封信，轻轻点头。信件现在由她保管。',{exact:true}).waitFor();await page.getByText('雨声仍在窗外持续，客栈里暂时安静下来。',{exact:true}).waitFor();await page.getByRole('button',{name:'直接手改',exact:true}).waitFor();await page.screenshot({path:join(images,'last-step-reader.png')});
  await page.getByRole('button',{name:'打开故事 GM',exact:true}).click();
  const panel=page.getByRole('region',{name:'通用故事 GM',exact:true}),current=panel.getByRole('region',{name:'当前故事状态',exact:true});
  await current.locator('code').waitFor();assert.equal(await current.locator('code').textContent(),start.sessionId);await current.getByText('密封信件当前由林遥持有。',{exact:true}).waitFor();
  const contrast=await panel.evaluate(el=>({foreground:getComputedStyle(el).color,parent:getComputedStyle(el.parentElement).color}));assert.equal(contrast.foreground,contrast.parent,'Native panel heading must inherit the host foreground');
  await current.scrollIntoViewIfNeeded();await page.screenshot({path:join(images,'gm-sidebar.png')});
  let release,responseReady;const held=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{responseReady=resolve;});let created;
  await page.route('**/api/rp-gm/request',async route=>{
    const body=route.request().postDataJSON();if(body?.action!=='startSample'){await route.continue();return;}
    const response=await route.fetch();created=await response.json();responseReady();await held;await route.fulfill({response});
  });
  await panel.getByRole('button',{name:'开始所选故事',exact:true}).click();await arrived;
  const rows=panel.locator('.rpgm-stories li'),count=await rows.count();let selected=false;
  for(let index=0;index<count;index++){const row=rows.nth(index);if(await row.getByText('进行中',{exact:true}).count()){await row.getByRole('button').click();if(await current.locator('code').textContent()===start.sessionId){selected=true;break;}}}
  assert.equal(selected,true,'Existing B must be selected while actual A response is held');release();await panel.getByRole('button',{name:'另开所选故事',exact:true}).waitFor();assert.equal(await current.locator('code').textContent(),start.sessionId);await current.getByText('密封信件当前由林遥持有。',{exact:true}).waitFor();assert.notEqual(created.sessionId,start.sessionId);await page.unroute('**/api/rp-gm/request');
  await page.getByRole('button',{name:'全屏',exact:true}).click();await panel.getByRole('heading',{name:'故事 GM',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(images,'gm-full.png')});
  await page.setViewportSize({width:390,height:844});await current.scrollIntoViewIfNeeded();const geometry=await panel.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));assert.ok(geometry.scrollWidth<=geometry.width+1,'GM panel must not overflow horizontally');await page.screenshot({path:join(images,'gm-narrow.png')});
  assert.deepEqual(errors,[]);const result={passed:true,browser:await browser.version(),browserPath,isolatedContext:true,extensionDisabled:true,sessionId:start.sessionId,lastStep:{independentReader:true,selectedOpeningReadable:true,transferReadable:true,retriedProseReadable:true,draftEntryVisible:true},m1:{actualCreatedSessionId:created.sessionId,selectedAfterLateResponse:start.sessionId,transportDelayOnly:true},viewports:[{width:1440,height:1000},{width:390,height:844}],geometry,consoleErrors:errors,screenshots:['docs/images/gm-sidebar.png','docs/images/gm-full.png','docs/images/gm-narrow.png','docs/images/last-step-reader.png']};await writeFile(join(run,'ui-summary.json'),JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){await page.screenshot({path:join(run,'ui-failure.png')}).catch(()=>{});await writeFile(join(run,'ui-failure-dom.txt'),await page.locator('body').innerText());await writeFile(join(run,'ui-errors.json'),JSON.stringify(errors,null,2));throw error;}
finally{await context.close();await browser.close();}
