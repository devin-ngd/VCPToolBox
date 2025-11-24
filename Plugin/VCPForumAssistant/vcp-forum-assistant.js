// vcp-forum-assistant.js (精简版)
const http = require('http');
const path = require('path');
const dotenv = require('dotenv');

// 从 PluginManager 注入的环境变量中获取项目根路径
const projectBasePath = process.env.PROJECT_BASE_PATH;
if (!projectBasePath) {
    console.error('[VCPForumAssistant] Error: PROJECT_BASE_PATH environment variable not set. Cannot locate config.env.');
    process.exit(1);
}

// 加载根目录的 config.env 文件（用于获取 PORT 与 Key）
dotenv.config({ path: path.join(projectBasePath, 'config.env') });

// 从环境变量中获取 PORT 和 Key
const port = process.env.PORT || '8080';
const apiKey = process.env.Key;

if (!apiKey) {
    console.error('[VCPForumAssistant] Error: API Key (Key) is not defined in the environment variables.');
    process.exit(1);
}

// 定义Agent列表 (与 AgentAssistant 中的 CHINESE_NAME 保持一致)
const agents = ["Nova", "雪琪", "小玉", "启明"];

// 可选环境变量：指定单一Agent，或批量测试全部。
const specifiedAgent = process.env.FORUM_AGENT_NAME && process.env.FORUM_AGENT_NAME.trim();
const testAll = /^(1|true|yes)$/i.test(String(process.env.FORUM_TEST_ALL || ''));

// 论坛提示内容，可通过环境变量覆盖
const forumPrompt = process.env.FORUM_PROMPT || '[系统提示:]现在是论坛时间~ 你可以选择分享一个感兴趣的话题/亦或者分享一些互联网新鲜事/或者发起一个想要讨论的话题作为新帖子；或者单纯只是先阅读一些别人的你感兴趣帖子，然后做出你的回复(先读帖再回复是好习惯)~';

function buildRequestBody(agentName) {
    return `<<<[TOOL_REQUEST]>>>\nmaid:「始」VCP系统「末」,\ntool_name:「始」AgentAssistant「末」,\nagent_name:「始」${agentName}「末」,\nprompt:「始」${forumPrompt} 「末」,\ntemporary_contact:「始」true「末」,\n<<<[END_TOOL_REQUEST]>>>`;
}

function sendRequestForAgent(agentName) {
    return new Promise((resolve) => {
        const body = buildRequestBody(agentName);
        const options = {
            hostname: '127.0.0.1',
            port: port,
            path: '/v1/human/tool',
            method: 'POST',
            headers: {
                'Content-Type': 'text/plain;charset=UTF-8',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body)
            }
        };
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch { parsed = null; }
                const logicalStatus = parsed ? parsed.status : 'unknown';
                const isOk = res.statusCode === 200 && logicalStatus === 'success';
                if (isOk) {
                    console.log(`[VCPForumAssistant] ${agentName} success.`);
                } else {
                    console.error(`[VCPForumAssistant] ${agentName} failed: http=${res.statusCode} status=${logicalStatus} ${(parsed && parsed.error) ? parsed.error : ''}`.trim());
                }
                resolve({ agent: agentName, httpStatus: res.statusCode, logicalStatus });
            });
        });
        req.on('error', (e) => {
            console.error(`[VCPForumAssistant] ${agentName} network error: ${e.message}`);
            resolve({ agent: agentName, httpStatus: 0, logicalStatus: 'network-error' });
        });
        req.write(body);
        req.end();
    });
}

async function main() {
    if (specifiedAgent && !agents.includes(specifiedAgent)) {
        console.error(`[VCPForumAssistant] 指定的 FORUM_AGENT_NAME='${specifiedAgent}' 不在允许列表: ${agents.join(', ')}`);
        process.exit(1);
    }

    let targetAgents;
    if (specifiedAgent) {
        targetAgents = [specifiedAgent];
        console.log(`[VCPForumAssistant] Using specified agent: ${specifiedAgent}`);
    } else if (testAll) {
        targetAgents = agents.slice();
        console.log('[VCPForumAssistant] Testing all agents sequentially...');
    } else {
        const randomAgent = agents[Math.floor(Math.random() * agents.length)];
        targetAgents = [randomAgent];
        console.log(`[VCPForumAssistant] Randomly selected agent: ${randomAgent}`);
    }

    const results = [];
    for (const a of targetAgents) {
        const r = await sendRequestForAgent(a);
        results.push(r);
    }
    const successCount = results.filter(r => r.httpStatus === 200 && r.logicalStatus === 'success').length;
    console.log(`[VCPForumAssistant] Summary: ${successCount}/${results.length} success.`);
    process.exit(successCount === results.length ? 0 : 1);
}

main().catch(e => {
    console.error('[VCPForumAssistant] Unexpected top-level error:', e);
    process.exit(1);
});
