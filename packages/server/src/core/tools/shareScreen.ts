import type { RenderCommand, ShareScreenArgs } from '@meeting-agent/protocol';
import type { DisplayPort } from '../ports';

/** share_screen: render the artifact on the stage (Display port). */
export async function runShareScreen(
  args: ShareScreenArgs,
  deps: { display: DisplayPort },
): Promise<void> {
  const cmd: RenderCommand = {
    kind: args.kind,
    payload: args.payload,
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.deliverableId !== undefined ? { deliverableId: args.deliverableId } : {}),
  };
  await deps.display.render(cmd);
}
