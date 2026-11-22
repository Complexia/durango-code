// Display labels for agy's native tool names (the `name` field on ACP
// tool_call updates and in subagent transcripts).
// agy's native tool names (the `name` field on tool_call updates).
export const ANTIGRAVITY_TOOL_LABELS = {
  run_command: 'Command',
  send_command_input: 'Command input',
  command_status: 'Command status',
  read_terminal: 'Terminal',
  view_file: 'Read',
  view_file_outline: 'Outline',
  view_code_item: 'Read',
  list_dir: 'List',
  find_by_name: 'Find',
  grep_search: 'Grep',
  codebase_search: 'Search',
  write_file: 'Write',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  edit_file: 'Edit',
  search_web: 'Web search',
  read_url_content: 'Web fetch',
  view_content_chunk: 'Web fetch',
  browser_subagent: 'Browser',
  generate_image: 'Image',
  schedule: 'Schedule',
  invoke_subagent: 'Subagent',
  start_subagent: 'Subagent',
  ask_question: 'Question',
  send_message: 'Message',
};

export const antigravityToolLabel = (name) => {
  if (!name) return 'Tool';
  if (ANTIGRAVITY_TOOL_LABELS[name]) return ANTIGRAVITY_TOOL_LABELS[name];
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} · ${mcp[2].replace(/_/g, ' ')}`;
  return String(name)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (letter) => letter.toUpperCase());
};

