// Pinned source lines 136-259
pub fn plan(source: &str, agent: &str, session_ref: &AgentSessionRef) -> Option<AgentResumePlan> {
    if !is_official_agent_source(source, agent) {
        return None;
    }

    let argv = match (source, agent, session_ref.kind) {
        ("herdr:claude", "claude", AgentSessionRefKind::Id) => {
            vec![
                "claude".into(),
                "--resume".into(),
                session_ref.value.clone(),
            ]
        }
        ("herdr:codex", "codex", AgentSessionRefKind::Id) => {
            vec!["codex".into(), "resume".into(), session_ref.value.clone()]
        }
        ("herdr:copilot", "copilot", AgentSessionRefKind::Id) => {
            vec!["copilot".into(), format!("--resume={}", session_ref.value)]
        }
        ("herdr:devin", "devin", AgentSessionRefKind::Id) => {
            vec!["devin".into(), "--resume".into(), session_ref.value.clone()]
        }
        ("herdr:droid", "droid", AgentSessionRefKind::Id) => {
            vec!["droid".into(), "--resume".into(), session_ref.value.clone()]
        }
        ("herdr:kimi", "kimi", AgentSessionRefKind::Id) => {
            vec!["kimi".into(), "--session".into(), session_ref.value.clone()]
        }
        ("herdr:mastracode", "mastracode", AgentSessionRefKind::Id) => {
            vec![
                "mastracode".into(),
                "--thread".into(),
                session_ref.value.clone(),
            ]
        }
        ("herdr:pi", "pi", AgentSessionRefKind::Path | AgentSessionRefKind::Id) => {
            vec!["pi".into(), "--session".into(), session_ref.value.clone()]
        }
        ("herdr:omp", "omp", AgentSessionRefKind::Path | AgentSessionRefKind::Id) => {
            // omp resume is `-r, --resume=<value>` (ID prefix or path); it has no
            // `--session` flag, unlike pi.
            vec!["omp".into(), format!("--resume={}", session_ref.value)]
        }
        ("herdr:hermes", "hermes", AgentSessionRefKind::Id) => {
            vec![
                "hermes".into(),
                "--resume".into(),
                session_ref.value.clone(),
            ]
        }
        ("herdr:opencode", "opencode", AgentSessionRefKind::Id) => {
            vec![
                "opencode".into(),
                "--session".into(),
                session_ref.value.clone(),
            ]
        }
        ("herdr:qodercli", "qodercli", AgentSessionRefKind::Id) => {
            vec![
                "qodercli".into(),
                "--resume".into(),
                session_ref.value.clone(),
            ]
        }
        ("herdr:qwen", "qwen", AgentSessionRefKind::Id) => {
            vec!["qwen".into(), "--resume".into(), session_ref.value.clone()]
        }
        ("herdr:kilo", "kilo", AgentSessionRefKind::Id) => {
            vec!["kilo".into(), "--session".into(), session_ref.value.clone()]
        }
        ("herdr:cursor", "cursor", AgentSessionRefKind::Id) => {
            vec![
                if cfg!(windows) {
                    "cursor-agent.cmd"
                } else {
                    "cursor-agent"
                }
                .into(),
                "--resume".into(),
                session_ref.value.clone(),
            ]
        }
        ("herdr:antigravity_cli", "agy", AgentSessionRefKind::Id) => {
            vec![
                "agy".into(),
                "--conversation".into(),
                session_ref.value.clone(),
            ]
        }
        ("herdr:grok", "grok", AgentSessionRefKind::Id) => {
            vec!["grok".into(), "--resume".into(), session_ref.value.clone()]
        }
        ("herdr:letta", "letta", AgentSessionRefKind::Id) => {
            if let Some(agent_id) = session_ref.value.strip_prefix("default:") {
                if agent_id.is_empty() {
                    return None;
                }
                vec![
                    "letta".into(),
                    "--conversation".into(),
                    "default".into(),
                    "--agent".into(),
                    agent_id.into(),
                ]
            } else {
                vec![
                    "letta".into(),
                    "--conversation".into(),
                    session_ref.value.clone(),
                ]
            }
        }
        _ => return None,
    };

    Some(AgentResumePlan {
        agent: agent.to_string(),
        argv,
        dedupe_key: dedupe_key(source, agent, session_ref),
    })
}

pub fn dedupe_key(source: &str, agent: &str, session_ref: &AgentSessionRef) -> String {
    format!(
