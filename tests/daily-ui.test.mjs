import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {helpers}=require('../app/daily-ui.js');

test('Daily Markdown renders headings, lists, quotes, code and tables without executing HTML',()=>{
 const html=helpers.renderMarkdown('# Plan\n\n**First** and _next_.\n\n- Read\n- Write\n\n> A source quote\n\n```js\n<script>alert("x")</script>\n```\n\n| Item | State |\n| --- | --- |\n| Paper | Ready |\n\n<img src=x onerror=alert(1)>');
 for(const fragment of ['<h2>Plan</h2>','<strong>First</strong>','<em>next</em>','<ul><li>Read</li><li>Write</li></ul>','<blockquote>','<table>','<th scope="col">Item</th>','<td>Ready</td>','&lt;script&gt;','&lt;img'])assert.ok(html.includes(fragment),fragment);
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img '));
});

test('Daily links allow safe web destinations and reject active or credentialed URLs',()=>{
 for(const value of ['javascript:alert(1)','data:text/html,<script>alert(1)</script>','vbscript:msgbox(1)','file:///etc/passwd','https://user:password@example.com','https://example.com\n/secret','//example.com'])assert.equal(helpers.safeLink(value),null,value);
 assert.deepEqual(helpers.safeLink('https://example.com/?q=a&b=c'),{kind:'external',href:'https://example.com/?q=a&b=c'});
 const html=helpers.renderMarkdown('[source](https://example.com/?q=a&b=c) [bad](javascript:alert(1))');
 assert.ok(html.includes('rel="noopener noreferrer"'));assert.ok(html.includes('referrerpolicy="no-referrer"'));assert.ok(html.includes('q=a&amp;b=c'));assert.ok(!html.includes('href="javascript:'));
});

test('local content links stay inside visible content roots and use the app preview action',()=>{
 const options={workspaceRoot:'/project/workspace'};
 assert.equal(helpers.localContentPath('/project/workspace/inbox/paper.pdf:12',options),'inbox/paper.pdf');
 assert.equal(helpers.localContentPath('workspace/courses/Fall/Stats/README.md',options),'courses/Fall/Stats/README.md');
 for(const value of ['/outside/paper.pdf','inbox/../paper.pdf','inbox/%2e%2e/paper.pdf','inbox/.ideas.json','inbox/%00.md','inbox\\paper.pdf','app/server.mjs','records/calendar.json','inbox/paper.pdf?token=x'])assert.equal(helpers.localContentPath(value,options),null,value);
 const html=helpers.renderMarkdown('[paper](/project/workspace/inbox/paper.pdf)',options);
 assert.ok(html.includes('data-daily-preview="inbox/paper.pdf"'));assert.ok(!html.includes('href="/project/'));
});

test('Markdown code and raw HTML cannot create nested actions or images',()=>{
 const html=helpers.renderMarkdown('`[bad](https://example.com)`\n\n```html\n<button onclick="alert(1)">go</button>\n```\n\n![reference](https://example.com/picture.png)');
 assert.ok(html.includes('<code>[bad](https://example.com)</code>'));assert.ok(html.includes('&lt;button onclick='));assert.ok(!html.includes('<button onclick='));assert.ok(!html.includes('<img'));
});

test('unfinished streaming Markdown stays safely renderable',()=>{
 const html=helpers.renderMarkdown('## Working\n\n```python\nprint("<hello>")');
 assert.ok(html.includes('<h3>Working</h3>'));assert.ok(html.includes('print(&quot;&lt;hello&gt;&quot;)'));assert.ok(html.endsWith('</code></pre></div>'));
 assert.equal(helpers.renderMarkdown('[unfinished <script>'),'<p>[unfinished &lt;script&gt;</p>');
 assert.doesNotThrow(()=>helpers.renderMarkdown('>'.repeat(20000)+' <script>'));
});

test('question metadata preserves real choices, descriptions, Other and secret flags',()=>{
 const questions=helpers.normalizeQuestions([{id:'choice',header:'Mode',question:'Choose one',isOther:true,options:[{label:'One',description:'First option'},{label:'Two'}]},{id:'secret',question:'Token',isSecret:true,options:null}]);
 assert.deepEqual(questions[0].options,[{label:'One',description:'First option'},{label:'Two',description:''}]);assert.equal(questions[0].isOther,true);assert.equal(questions[1].isSecret,true);assert.deepEqual(questions[1].options,[]);
 assert.deepEqual(helpers.answerPayload(questions,{choice:'My own answer',secret:' secret value '}),{answers:{choice:{answers:['My own answer']},secret:{answers:[' secret value ']}}});
 assert.throws(()=>helpers.answerPayload(questions,{choice:'One',secret:''}),/every question/);assert.throws(()=>helpers.answerPayload(questions,{choice:'One',secret:'x'.repeat(4001)}),/4,000/);
});

test('Enter sends only outside IME composition and keeps Shift+Enter for a newline',()=>{
 const event={key:'Enter',shiftKey:false,isComposing:false,keyCode:13};
 assert.equal(helpers.shouldSubmitEnter(event,{now:1000,lastCompositionEnd:0}),true);
 for(const change of [{shiftKey:true},{isComposing:true},{keyCode:229},{key:'a'}])assert.equal(helpers.shouldSubmitEnter({...event,...change},{now:1000}),false);
 assert.equal(helpers.shouldSubmitEnter(event,{composing:true,now:1000}),false);assert.equal(helpers.shouldSubmitEnter(event,{now:1000,lastCompositionEnd:950}),false);assert.equal(helpers.shouldSubmitEnter(event,{now:1100,lastCompositionEnd:950}),true);
});
