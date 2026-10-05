import { getLocalApiAuthHeaders } from "./local-api-auth";

// Frontend client for Xiaomi MiMo Token Plan Cookie management.

async function payload(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `Request failed with HTTP ${response.status}`);
  }
  return data;
}

export async function getXiaomiTokenPlanConfig() {
  const response = await fetch("/functions/tokentracker-xiaomi-token-plan-config", {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  return payload(response);
}

export async function saveXiaomiTokenPlanCookie(cookie) {
  const auth = await getLocalApiAuthHeaders();
  const response = await fetch("/functions/tokentracker-xiaomi-token-plan-config", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...auth,
    },
    cache: "no-store",
    body: JSON.stringify({ action: "save", cookie }),
  });
  return payload(response);
}

export async function clearXiaomiTokenPlanCookie() {
  const auth = await getLocalApiAuthHeaders();
  const response = await fetch("/functions/tokentracker-xiaomi-token-plan-config", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...auth,
    },
    cache: "no-store",
    body: JSON.stringify({ action: "clear" }),
  });
  return payload(response);
}
