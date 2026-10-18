// Supported pinned-engine CLI backend: Codex owns its installed login; the gateway never imports it.
export function registerCodex(api) {
  api.registerCliBackend({
    id: 'openai-codex', modelProvider: 'openai',
    authEpochMode: 'profile-only', autoSelectAuthProfile: false,
    bundleMcp: true, bundleMcpMode: 'codex-config-overrides',
    nativeToolMode: 'none', toolAvailabilityEnforcement: 'execution-args', sideQuestionToolMode: 'disabled',
    config: {
      command: 'codex', input: 'stdin', output: 'jsonl', modelArg: '--model', sessionMode: 'none',
      args: ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
        '--sandbox', 'read-only', '-c', 'forced_login_method="chatgpt"',
        '-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.apps=false',
        '-c', 'features.plugins=false', '-c', 'features.hooks=false', '-c', 'features.multi_agent=false',
        '-c', 'features.image_generation=false', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-'],
      clearEnv: ['CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_OSS_BASE_URL'],
      systemPromptFileConfigArg: '-c', systemPromptFileConfigKey: 'model_instructions_file', systemPromptWhen: 'always',
    },
    parseJsonlEvent(line) {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') return { kind: 'text', text: event.item.text };
      if (event.type === 'turn.completed') return { kind: 'result', usage: {
        input: event.usage?.input_tokens, output: event.usage?.output_tokens, cacheRead: event.usage?.cached_input_tokens,
      } };
      if (event.type === 'turn.failed' || event.type === 'error') return { kind: 'result', errorText: event.error?.message ?? event.message ?? 'Codex failed' };
      return null;
    },
  });
}
