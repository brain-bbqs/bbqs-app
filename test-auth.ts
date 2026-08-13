const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function test() {
  const headers = {
    apikey: ANON_KEY,
  };
  
  console.log("Testing with only apikey header...");
  const res1 = await fetch(`${SUPABASE_URL}/rest/v1/grants?select=*&limit=1`, { headers });
  console.log(`Status: ${res1.status}`);
  if (res1.status === 401) {
    console.log("Body:", await res1.text());
  }

  console.log("\nTesting with apikey and Authorization: Bearer <key>...");
  const res2 = await fetch(`${SUPABASE_URL}/rest/v1/grants?select=*&limit=1`, {
    headers: {
      ...headers,
      Authorization: `Bearer ${ANON_KEY}`
    }
  });
  console.log(`Status: ${res2.status}`);
  if (res2.status === 401) {
    console.log("Body:", await res2.text());
  }
}

test();
