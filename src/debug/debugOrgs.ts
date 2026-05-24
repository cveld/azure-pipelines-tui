import { getToken, httpGet, fetchOrgs, fetchProjects } from "../lib/api.js";

async function main() {
  const token = await getToken();
  console.log("Token OK\n");

  console.log("Fetching orgs…");
  const orgs = await fetchOrgs(token);
  console.log("Orgs:", orgs.map(o => o.accountName));

  if (orgs.length > 0) {
    const first = orgs[0].accountName;
    console.log(`\nFetching projects for ${first}…`);
    const projects = await fetchProjects(first, token);
    console.log("Projects:", projects.map(p => p.name));
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
