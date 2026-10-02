import { randomUUID } from 'node:crypto';
import type { NeedSignIn, ResumeState } from '../browser.ts';

export type ResumeDispatch = (input: { member: string; sessionKey: string; idempotencyKey: string; message: string }) => Promise<'accepted' | 'refused' | 'unknown'>;
export function newResume(request: NeedSignIn, attempt = 1): ResumeState {
  return { key: `signin:${request.id}:resume:${attempt}:${randomUUID()}`, attempt, state: 'pending' };
}
export function recoverResume(request: NeedSignIn): void {
  const resume = request.settled?.resume;
  // Neither process liveness nor an evictable gateway cache is submission proof.
  if (resume && ['pending', 'accepted', 'submitted'].includes(resume.state)) resume.state = 'indeterminate';
}
export async function dispatchResume(request: NeedSignIn, dispatch: ResumeDispatch): Promise<ResumeState['state']> {
  const resume = request.settled?.resume;
  if (request.settled?.state !== 'verified' || resume?.state !== 'pending') throw new Error('resume unavailable');
  try {
    const answer = await dispatch({ member: request.member, sessionKey: request.sessionKey, idempotencyKey: resume.key,
      message: `The person signed in to ${request.site}. Continue the task.` });
    return answer === 'accepted' ? 'accepted' : answer === 'refused' ? 'failed' : 'indeterminate';
  } catch { return 'indeterminate'; }
}
