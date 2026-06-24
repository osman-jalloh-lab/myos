// Mercury — external tool / MCP agent
//
// Owns: web_search, google_flights_search, flight_search, hotel_search, maps, weather, price_compare.
// NOT for: email, calendar, jobs, finance, memory, HR, or daily briefing (those
// belong to existing agents — Mercury will say so and redirect).
//
// Safety rules (hard-coded, no override):
//  1. Never books, purchases, or commits to anything. Transactional intents
//     create a create_task ApprovalAction so Osman can act manually.
//  2. Never exposes API keys in responses.
//  3. Only calls tools that are verified-connected (env key present).
//  4. Data class is always PUBLIC — no private user data is sent to external APIs.

import { callModel } from "@/lib/modelRouter";
import { logHandoff } from "@/agents/hermes";
import { createApproval } from "@/lib/approvals";
import { persistToolFailure } from "@/lib/context-persistence";

// ── Tool registry ─────────────────────────────────────────────────────────────
// A tool is "connected" if all its required env keys are present at boot time.
// The registry is evaluated once at module load — Vercel restarts the function
// when new env vars are deployed, so this stays accurate without a cache.

export interface ToolDefinition {
  id: string;
  label: string;
  category: "search" | "travel" | "location" | "data" | "shopping";
  description: string;
  requiredParams: string[];
  connected: boolean;
  notConnectedHint: string;
}

function keysPresent(...keys: string[]): boolean {
  return keys.every((k) => !!process.env[k]);
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  web_search: {
    id: "web_search",
    label: "Web Search",
    category: "search",
    description: "Search the public web for current information, news, or any topic",
    requiredParams: ["query"],
    connected: keysPresent("FIRECRAWL_API_KEY"),
    notConnectedHint: "Add FIRECRAWL_API_KEY (firecrawl.dev) to Vercel env vars to enable live web search.",
  },
  google_flights_search: {
    id: "google_flights_search",
    label: "Google Flights Search",
    category: "travel",
    description: "Search Google Flights for real-time flight options, prices, airlines, schedules, and layover details. Preferred for all flight searches.",
    requiredParams: ["departure_id", "arrival_id", "outbound_date"],
    connected: keysPresent("SERPAPI_API_KEY"),
    notConnectedHint: "Add SERPAPI_API_KEY (serpapi.com) to Vercel env vars to enable Google Flights search.",
  },
  flight_search: {
    id: "flight_search",
    label: "Flight Search",
    category: "travel",
    description: "Fallback flight search via Amadeus when Google Flights is not available",
    requiredParams: ["origin", "destination", "departure_date", "adults"],
    connected: keysPresent("AMADEUS_CLIENT_ID", "AMADEUS_CLIENT_SECRET"),
    notConnectedHint: "Add AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET (developers.amadeus.com) to enable flight search.",
  },
  hotel_search: {
    id: "hotel_search",
    label: "Hotel Search",
    category: "travel",
    description: "Search for hotels and nightly rates in a city",
    requiredParams: ["city", "check_in", "check_out"],
    connected: keysPresent("AMADEUS_CLIENT_ID", "AMADEUS_CLIENT_SECRET"),
    notConnectedHint: "Add AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET to enable hotel search.",
  },
  maps: {
    id: "maps",
    label: "Maps & Places",
    category: "location",
    description: "Find restaurants, businesses, landmarks, or any place by name or description",
    requiredParams: ["query"],
    connected: keysPresent("GOOGLE_MAPS_API_KEY"),
    notConnectedHint: "Add GOOGLE_MAPS_API_KEY (console.cloud.google.com → Places API) to enable place search.",
  },
  weather: {
    id: "weather",
    label: "Weather",
    category: "data",
    description: "Current weather conditions and forecast for any city",
    requiredParams: ["city"],
    connected: keysPresent("OPENWEATHER_API_KEY"),
    notConnectedHint: "Add OPENWEATHER_API_KEY (openweathermap.org/api) to enable weather lookups.",
  },
  price_compare: {
    id: "price_compare",
    label: "Price Comparison",
    category: "shopping",
    description: "Compare prices for a product across online stores",
    requiredParams: ["product"],
    connected: false,
    notConnectedHint: "Price comparison is not yet integrated. A RapidAPI shopping endpoint would cover this.",
  },
};

// Domains that belong to existing agents — Mercury redirects rather than handles.
const OUT_OF_SCOPE_DOMAINS: { match: RegExp; agent: string }[] = [
  { match: /\b(email|inbox|gmail|draft|send|reply to|triage)\b/i, agent: "Iris" },
  { match: /\b(calendar|schedule|meeting|event|agenda|appointment)\b/i, agent: "Kairos" },
  { match: /\b(job|resume|cover letter|application|hiring|interview|apply)\b/i, agent: "Athena" },
  { match: /\b(budget|expense|finance|debt|spend|money owed|paycheck|income track)\b/i, agent: "Plutus" },
  { match: /\b(remember|memory|recall|note that|log this|what did we decide)\b/i, agent: "Mnemosyne" },
  { match: /\b(brief me|morning brief|daily brief|what'?s up|overview|argus)\b/i, agent: "Argus" },
  { match: /\b(i-?9|i9|uscis|work authorization|everify|m-274|themis)\b/i, agent: "Themis" },
];

// ── Intent extraction ─────────────────────────────────────────────────────────

interface MercuryIntent {
  tool: string | null;
  params: Record<string, string>;
  missing: string[];
  isTransactional: boolean;
}

async function extractIntent(query: string): Promise<MercuryIntent> {
  const toolList = Object.values(TOOL_REGISTRY)
    .map((t) => `${t.id}: ${t.description}. Required: ${t.requiredParams.join(", ")}.`)
    .join("\n");

  const result = await callModel({
    taskType: "chat-mercury-intent",
    dataClass: "PUBLIC",
    systemPrompt: `You extract structured intent from a user query to dispatch to an external tool.

Available tools:
${toolList}

Return ONLY valid JSON, no explanation:
{
  "tool": "<tool_id or null>",
  "params": { "<param>": "<value or empty string>" },
  "missing": ["<required param names that are missing or ambiguous>"],
  "isTransactional": <true if user wants to book/buy/reserve/purchase, false for search/lookup>
}

Rules:
- If no tool fits, set tool to null.
- Extract dates as YYYY-MM-DD. If a date is relative ("this weekend", "next Friday", "next month") and today is ${new Date().toISOString().slice(0, 10)}, infer the actual date.
- Airport codes: extract 3-letter IATA codes where possible (Austin = AUS, Atlanta = ATL, New York = JFK, Los Angeles = LAX, Chicago = ORD, Dallas = DFW, Miami = MIA, Denver = DEN, Seattle = SEA, Boston = BOS, DC = DCA).
- For ALL flight search requests, prefer google_flights_search over flight_search.
  - google_flights_search params: departure_id (IATA), arrival_id (IATA), outbound_date (YYYY-MM-DD), return_date (YYYY-MM-DD if round trip), type ("1"=round trip "2"=one-way, default "2"), adults (default "1"), cabin_class (optional: ECONOMY PREMIUM_ECONOMY BUSINESS FIRST).
  - If the user implies round trip ("round trip", "there and back", "return flight"), set type="1" and add return_date to missing if not given.
  - If the user says "one way" or "one-way", set type="2".
  - Mark departure_id or arrival_id as missing if only city names were given and you cannot map them to IATA codes.
- If the city for hotel_search is not a 3-letter code, put it in "city" and leave "city_code" blank.
- isTransactional = true only when the user explicitly wants to finalize a booking or purchase. Searching is NOT transactional.
- For web_search, the full user query is the search query if nothing more specific is available.`,
    userPrompt: query,
  });

  try {
    return JSON.parse(result.text.replace(/```json\n?|```/g, "").trim()) as MercuryIntent;
  } catch {
    // Fallback: treat anything remaining as a web search attempt
    return { tool: "web_search", params: { query }, missing: [], isTransactional: false };
  }
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function runWebSearch(params: Record<string, string>): Promise<string> {
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: params.query, limit: 6 }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Firecrawl ${res.status}`);

  const data = (await res.json()) as {
    data?: { url: string; title?: string; description?: string }[];
  };

  const results = data.data ?? [];
  if (!results.length) return "No results found.";

  return results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.title ?? r.url}: ${r.description ?? ""} [${r.url}]`)
    .join("\n");
}

async function runWeather(params: Record<string, string>): Promise<string> {
  const res = await fetch(
    `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(params.city)}&appid=${process.env.OPENWEATHER_API_KEY}&units=imperial`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`OpenWeather ${res.status}`);
  const d = (await res.json()) as {
    name: string;
    main: { temp: number; feels_like: number; humidity: number };
    weather: { description: string }[];
    wind: { speed: number };
    sys: { country: string };
  };
  return `${d.name}, ${d.sys.country}: ${d.weather[0]?.description} — ${Math.round(d.main.temp)}°F (feels like ${Math.round(d.main.feels_like)}°F). Humidity ${d.main.humidity}%, wind ${Math.round(d.wind.speed)} mph.`;
}

async function getAmadeusToken(): Promise<string> {
  const res = await fetch("https://test.api.amadeus.com/v1/security/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.AMADEUS_CLIENT_ID!,
      client_secret: process.env.AMADEUS_CLIENT_SECRET!,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Amadeus auth ${res.status}`);
  const { access_token } = (await res.json()) as { access_token: string };
  return access_token;
}

async function runFlightSearch(params: Record<string, string>): Promise<string> {
  const token = await getAmadeusToken();
  const url = new URL("https://test.api.amadeus.com/v2/shopping/flight-offers");
  url.searchParams.set("originLocationCode", params.origin.toUpperCase());
  url.searchParams.set("destinationLocationCode", params.destination.toUpperCase());
  url.searchParams.set("departureDate", params.departure_date);
  url.searchParams.set("adults", params.adults || "1");
  url.searchParams.set("max", "5");
  if (params.return_date) url.searchParams.set("returnDate", params.return_date);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`Amadeus flights ${res.status}`);
  const data = (await res.json()) as {
    data?: {
      price: { total: string; currency: string };
      itineraries: {
        duration: string;
        segments: {
          departure: { iataCode: string; at: string };
          arrival: { iataCode: string; at: string };
          carrierCode: string;
          numberOfStops: number;
        }[];
      }[];
    }[];
  };
  if (!data.data?.length) return "No flights found for those dates and cities.";

  return data.data
    .map((offer, i) => {
      const itin = offer.itineraries[0];
      const seg = itin.segments[0];
      const stops = seg.numberOfStops === 0 ? "nonstop" : `${seg.numberOfStops} stop(s)`;
      const dep = seg.departure.at.replace("T", " ").slice(0, 16);
      const dur = itin.duration.replace("PT", "").toLowerCase();
      return `${i + 1}. ${seg.carrierCode} ${seg.departure.iataCode}→${seg.arrival.iataCode} — departs ${dep} — $${offer.price.total} ${offer.price.currency} — ${dur}, ${stops}`;
    })
    .join("\n");
}

async function runHotelSearch(params: Record<string, string>): Promise<string> {
  const token = await getAmadeusToken();

  // City → hotel list
  const cityCode = (params.city_code || params.city).slice(0, 3).toUpperCase();
  const listRes = await fetch(
    `https://test.api.amadeus.com/v1/reference-data/locations/hotels/by-city?cityCode=${cityCode}&ratings=3,4,5&hotelSource=ALL`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }
  );
  if (!listRes.ok) throw new Error(`Amadeus hotel list ${listRes.status}`);
  const listData = (await listRes.json()) as { data?: { hotelId: string; name: string }[] };
  const hotelIds = (listData.data ?? []).slice(0, 5).map((h) => h.hotelId);
  if (!hotelIds.length) return "No hotels found for that city.";

  const offersUrl = new URL("https://test.api.amadeus.com/v3/shopping/hotel-offers");
  offersUrl.searchParams.set("hotelIds", hotelIds.join(","));
  offersUrl.searchParams.set("checkInDate", params.check_in);
  offersUrl.searchParams.set("checkOutDate", params.check_out);
  offersUrl.searchParams.set("adults", params.guests || "1");

  const offersRes = await fetch(offersUrl.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12000),
  });
  if (!offersRes.ok) throw new Error(`Amadeus hotel offers ${offersRes.status}`);
  const data = (await offersRes.json()) as {
    data?: {
      hotel: { name: string };
      offers: {
        price: { total: string; currency: string };
        room: { typeEstimated?: { beds?: number; bedType?: string } };
      }[];
    }[];
  };
  if (!data.data?.length) return "No hotel offers found for those dates.";

  return data.data
    .map((h, i) => {
      const offer = h.offers[0];
      const room = offer?.room?.typeEstimated;
      const bedDesc = room?.beds ? ` — ${room.beds} ${room.bedType} bed(s)` : "";
      return `${i + 1}. ${h.hotel.name} — $${offer?.price.total} ${offer?.price.currency}/stay${bedDesc}`;
    })
    .join("\n");
}

async function runMapsSearch(params: Record<string, string>): Promise<string> {
  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(params.query)}&key=${process.env.GOOGLE_MAPS_API_KEY}`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Google Maps ${res.status}`);
  const data = (await res.json()) as {
    results?: { name: string; formatted_address: string; rating?: number; user_ratings_total?: number }[];
  };
  if (!data.results?.length) return "No places found.";
  return data.results
    .slice(0, 5)
    .map(
      (p, i) =>
        `${i + 1}. ${p.name} — ${p.formatted_address}${p.rating ? ` — ⭐ ${p.rating} (${p.user_ratings_total?.toLocaleString()} reviews)` : ""}`
    )
    .join("\n");
}

// ── Google Flights via SerpAPI ────────────────────────────────────────────────

interface GFlightSegment {
  airline: string;
  flight_number: string;
  airplane?: string;
  departure_airport: { name: string; id: string; time: string };
  arrival_airport: { name: string; id: string; time: string };
  duration: number;
  extensions?: string[];
}

interface GFlightOffer {
  flights: GFlightSegment[];
  layovers?: { duration: number; name: string; id: string; overnight?: boolean }[];
  total_duration: number;
  price: number;
  type: string;
  carbon_emissions?: { this_flight?: number; typical_for_this_route?: number; difference_percent?: number };
}

interface SerpFlightsResponse {
  best_flights?: GFlightOffer[];
  other_flights?: GFlightOffer[];
  price_insights?: { lowest_price?: number; price_level?: string; typical_range?: number[] };
  error?: string;
}

async function runGoogleFlightsSearch(params: Record<string, string>): Promise<string> {
  const searchParams = new URLSearchParams({
    engine: "google_flights",
    api_key: process.env.SERPAPI_API_KEY!,
    departure_id: (params.departure_id || params.origin || "").toUpperCase(),
    arrival_id: (params.arrival_id || params.destination || "").toUpperCase(),
    outbound_date: params.outbound_date || params.departure_date || "",
    type: params.type || (params.return_date ? "1" : "2"),
    adults: params.adults || "1",
    currency: "USD",
    hl: "en",
  });

  if (params.return_date) searchParams.set("return_date", params.return_date);
  if (params.cabin_class) searchParams.set("travel_class", params.cabin_class);
  if (params.children) searchParams.set("children", params.children);

  const res = await fetch(`https://serpapi.com/search.json?${searchParams.toString()}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);

  const data = (await res.json()) as SerpFlightsResponse;
  if (data.error) throw new Error(data.error);

  const allFlights = [...(data.best_flights ?? []), ...(data.other_flights ?? [])];
  if (!allFlights.length) return "No flights found for those dates and cities.";

  const lines: string[] = [];

  // Price context header
  if (data.price_insights) {
    const pi = data.price_insights;
    if (pi.lowest_price) lines.push(`Lowest price found: $${pi.lowest_price}`);
    if (pi.typical_range?.length === 2) lines.push(`Typical range: $${pi.typical_range[0]}–$${pi.typical_range[1]}`);
    if (pi.price_level) lines.push(`Price level: ${pi.price_level}`);
    lines.push("");
  }

  // Top results
  for (const [i, offer] of allFlights.slice(0, 5).entries()) {
    const first = offer.flights[0];
    const last = offer.flights[offer.flights.length - 1];
    const stops = offer.layovers?.length ?? 0;
    const stopStr = stops === 0 ? "nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`;
    const dur = `${Math.floor(offer.total_duration / 60)}h ${offer.total_duration % 60}m`;
    const dep = first.departure_airport.time;
    const arr = last.arrival_airport.time;
    const layoverNote = offer.layovers
      ?.map((l) => `${l.id} ${Math.floor(l.duration / 60)}h${l.overnight ? " overnight" : ""}`)
      .join(", ");
    const bagNote = first.extensions?.find((e) => /bag|carry|check/i.test(e));

    let line = `${i + 1}. ${first.airline} (${first.flight_number}) — $${offer.price} — ${dep} → ${arr} — ${dur}, ${stopStr}`;
    if (layoverNote) line += ` (via ${layoverNote})`;
    if (bagNote) line += ` — ${bagNote}`;
    if (first.airplane) line += ` — ${first.airplane}`;
    lines.push(line);
  }

  lines.push("");
  lines.push("Search results only — nothing has been booked. Book manually or request approval.");
  return lines.join("\n");
}

async function dispatchTool(toolId: string, params: Record<string, string>): Promise<string> {
  switch (toolId) {
    case "web_search":            return runWebSearch(params);
    case "weather":               return runWeather(params);
    case "google_flights_search": return runGoogleFlightsSearch(params);
    case "flight_search":         return runFlightSearch(params);
    case "hotel_search":          return runHotelSearch(params);
    case "maps":                  return runMapsSearch(params);
    default: throw new Error(`No implementation for tool: ${toolId}`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export interface MercuryResult {
  reply: string;
  toolUsed: string | null;
  pendingApprovals?: { id: string; actionType: string }[];
}

export async function handleMercuryRequest(
  userId: string,
  query: string,
  channel?: string
): Promise<MercuryResult> {
  const isTelegram = channel === "telegram";

  function fmt(plain: string, html: string): string {
    return isTelegram ? html : plain;
  }

  // Step 1: guard against out-of-scope domains — redirect rather than try to handle
  for (const { match, agent } of OUT_OF_SCOPE_DOMAINS) {
    if (match.test(query)) {
      return {
        reply: fmt(
          `That request belongs to ${agent}, not Mercury. Try asking Hermes directly or use /${agent.toLowerCase()} to address that agent.`,
          `That request belongs to <b>${agent}</b>, not Mercury. Try <code>/${agent.toLowerCase()}</code> to address that agent directly.`
        ),
        toolUsed: null,
      };
    }
  }

  // Step 2: extract intent
  let intent: MercuryIntent;
  try {
    intent = await extractIntent(query);
  } catch (err) {
    await logHandoff({ agentName: "mercury", inputSummary: query.slice(0, 200), status: "failed" });
    return { reply: "Intent extraction failed — try rephrasing your request.", toolUsed: null };
  }

  await logHandoff({ agentName: "mercury", inputSummary: `[${intent.tool ?? "none"}] ${query.slice(0, 180)}` });

  // Step 3: no matching tool
  if (!intent.tool) {
    return {
      reply: fmt(
        "I couldn't match that to any of my tools (web search, flights, hotels, maps, weather, price comparison). Try being more specific, or ask Hermes if you're not sure which agent to use.",
        "I couldn't match that to any of my tools (web search, flights, hotels, maps, weather, price comparison). Try being more specific, or ask Hermes if you're not sure which agent to use."
      ),
      toolUsed: null,
    };
  }

  const tool = TOOL_REGISTRY[intent.tool];

  // Step 4: tool not connected
  if (!tool?.connected) {
    const name = tool?.label ?? intent.tool;
    const hint = tool?.notConnectedHint ?? "Add the required API key to your Vercel environment variables.";
    await persistToolFailure(userId, name, hint).catch(() => undefined);
    return {
      reply: fmt(`${name} is not connected yet. ${hint}`, `<b>${name}</b> is not connected yet.\n\n${hint}`),
      toolUsed: intent.tool,
    };
  }

  // Step 5: required params missing — ask before calling any API
  if (intent.missing.length > 0) {
    const missingList = intent.missing.map((m) => m.replace(/_/g, " ")).join(", ");
    return {
      reply: fmt(
        `I can search ${tool.label} for you, but I need: ${missingList}. Can you share those?`,
        `I can search <b>${tool.label}</b> for you, but I need a few more details: <i>${missingList}</i>. Can you share those?`
      ),
      toolUsed: intent.tool,
    };
  }

  // Step 6: transactional intent — never book/buy; queue an approval task instead
  if (intent.isTransactional) {
    const taskTitle = `Follow up: ${tool.label} booking — ${Object.values(intent.params).filter(Boolean).join(", ")}`;
    const approval = await createApproval(userId, "create_task", {
      title: taskTitle,
      description: `Mercury queued this from your message: "${query.slice(0, 200)}"`,
      source: "mercury",
      priority: "medium",
    });
    return {
      reply: fmt(
        `I don't book or purchase anything automatically. I've queued a task — "${taskTitle}" — in your approval queue so you can action it when ready.`,
        `I never book or purchase anything automatically.\n\nI've queued a task in your approvals:\n<i>${taskTitle}</i>\n\nApprove it to create the task, then follow through yourself.`
      ),
      toolUsed: intent.tool,
      pendingApprovals: [{ id: approval.id, actionType: approval.actionType }],
    };
  }

  // Step 7: execute the lookup
  let rawData: string;
  try {
    rawData = await dispatchTool(intent.tool, intent.params);
  } catch (err) {
    const msg = (err as Error).message;
    await logHandoff({
      agentName: "mercury",
      inputSummary: `${intent.tool} — ${query.slice(0, 100)}`,
      outputSummary: `error: ${msg}`,
      status: "failed",
    });
    await persistToolFailure(userId, tool.label, msg).catch(() => undefined);
    return {
      reply: fmt(
        `${tool.label} lookup failed: ${msg}. Check the API key or try again.`,
        `<b>${tool.label}</b> lookup failed: <code>${msg}</code>. Check the API key in Vercel env vars or try again.`
      ),
      toolUsed: intent.tool,
    };
  }

  // Step 8: synthesize a clean reply from raw results
  const systemPrompt = isTelegram
    ? `You are Mercury, Hermes OS's external tool agent. You ran a ${tool.label} lookup. Present results cleanly with Telegram HTML (<b>bold</b> for key values, plain dashes for lists). Keep it under 6 lines. End with a single short note that these are search results only — you have not booked or purchased anything.`
    : `You are Mercury, Hermes OS's external tool agent. Summarize the ${tool.label} results cleanly in plain text (no markdown). Keep it under 150 words. End with a brief note that these are search results only — nothing has been booked or purchased.`;

  const synthesized = await callModel({
    userId,
    taskType: "chat-mercury",
    dataClass: "PUBLIC",
    systemPrompt,
    userPrompt: `User asked: "${query}"\n\nRaw ${tool.label} results:\n${rawData}`,
  });

  await logHandoff({
    agentName: "mercury",
    inputSummary: `${intent.tool} — ${query.slice(0, 100)}`,
    outputSummary: synthesized.text.slice(0, 200),
    modelProvider: synthesized.provider,
    status: "completed",
  });

  return { reply: synthesized.text, toolUsed: intent.tool };
}
