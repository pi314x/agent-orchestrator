import { z } from 'zod';
import { toolError, toolOk } from './result.js';
import { denyWithoutAdminScope } from './scopes.js';
import type { ToolRegistration } from './types.js';

const PresetSchema = z.object({
  name: z.string(),
  grants: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const grantPresetSaveTool: ToolRegistration = {
  name: 'grant_preset_save',
  profile: 'full',

  register(server, deps) {
    server.registerTool(
      'grant_preset_save',
      {
        title: 'Save a grant preset',
        description:
          'Save a named bundle of downstream tool grants an admin curates once ("files", "files/read_file") for anyone to stamp onto an agent with agent_create grantPreset. Grants are copied onto the agent at create time, never linked. Overwriting an existing name replaces it.',
        inputSchema: z.object({
          name: z.string().min(1),
          grants: z.array(z.string().min(1)).min(1)
        }),
        outputSchema: z.object({ preset: PresetSchema }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (args, ctx) => {
        const denied = denyWithoutAdminScope(ctx, 'grant_preset_save');
        if (denied !== undefined) return denied;
        try {
          const preset = await deps.services.presets.save(args.name, args.grants);
          return toolOk({ preset });
        } catch (error) {
          return toolError(error);
        }
      }
    );
  }
};

export const grantPresetListTool: ToolRegistration = {
  name: 'grant_preset_list',
  profile: 'standard',

  register(server, deps) {
    server.registerTool(
      'grant_preset_list',
      {
        title: 'List grant presets',
        description:
          'List the admin-curated tool-grant bundles available to agent_create grantPreset. Use it to name a preset instead of hand-writing toolGrants.',
        inputSchema: z.object({}),
        outputSchema: z.object({ presets: z.array(PresetSchema) }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async () => {
        const presets = await deps.services.presets.list();
        return toolOk({ presets });
      }
    );
  }
};
