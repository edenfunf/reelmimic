// Local diagnostics only. This command does not invoke an agent or call a provider.
import '../server/env.ts';
import { readRouting, resolveRoute, preflightRoute, routeLabel, ROLE_GROUP } from '../server/agents/routing.ts';

try {
  const config = readRouting();
  const project = process.argv[2] || '<new-project>';
  console.log('Advanced: model routing (requested routes; existing sessions retain their saved routes)');
  for (const phase of Object.keys(ROLE_GROUP)) {
    const route = resolveRoute(config, project, phase);
    preflightRoute(route, phase);
    console.log(`${phase}: ${route ? routeLabel(route, route.runtime) : 'legacy UI picker / CLI defaults; provider/model/usage/cost=unknown'}`);
  }
  console.log('No provider compatibility or model capability is verified by this command. No automatic fallback.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
