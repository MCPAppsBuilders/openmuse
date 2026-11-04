import { useCallback, useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { Button, Card, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

interface Review {
  id: string;
  kind: "create_checkout" | "pay_order";
  status: string;
  expiresAt: number;
  quote: {
    customer_id: number;
    amount_minor: number;
    currency: string;
    shipping_minor: number;
    delivery: { name?: string };
    items: {
      product_id: number;
      attribute_id: number;
      name: string;
      quantity: number;
      line_amount_minor: number;
    }[];
  };
  authorization?: string;
  result?: unknown;
  receipt?: unknown;
}
interface ShoppingStatus {
  configured: boolean;
  connected: boolean;
  expiresAt?: number;
  reviews: Review[];
}
const money = (amount: number) => `${(amount / 100).toFixed(2)} €`;

// Authenticated native application UI. No approval tool is exposed to the model.
export function ShoppingPanel() {
  const { api, notify } = useWorkspace();
  const [data, setData] = useState<ShoppingStatus>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(await api.request<ShoppingStatus>("/api/shopping"));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function act(path: string, body: unknown = {}) {
    setBusy(true);
    setError("");
    try {
      const result = await api.request<{ url?: string }>(path, body);
      if (result.url) await Linking.openURL(result.url);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (data && !data.configured) return null;
  return (
    <Card>
      <View style={{ gap: 14 }}>
        <Text style={s.title}>Shopping Lab · fonds fictifs</Text>
        <Text style={s.muted}>
          Compte acheteur PrestaShop : {data?.connected ? "connecté" : "à connecter"}. Les prix et
          la livraison sont calculés par la boutique de test.
        </Text>
        <ErrorNotice error={error} />
        <Button busy={busy} primary onPress={() => void act("/api/shopping/connect")}>
          Connecter mon compte acheteur
        </Button>
        <Button busy={busy} onPress={() => void refresh()}>
          Actualiser Shopping Lab
        </Button>
        {data?.connected && (
          <Button busy={busy} danger onPress={() => void act("/api/shopping/disconnect")}>
            Déconnecter le compte acheteur
          </Button>
        )}
        {data?.reviews.map((r) => (
          <View
            key={r.id}
            style={{ gap: 10, borderTopWidth: 1, borderTopColor: "#DDD", paddingTop: 16 }}
          >
            <Text style={s.text}>
              {r.kind === "create_checkout"
                ? "Créer la commande de test"
                : "Autoriser le wallet MPP de test"}{" "}
              · {r.status}
            </Text>
            <Text style={s.muted}>
              Compte boutique #{r.quote.customer_id} · {r.quote.currency}
            </Text>
            {r.quote.items.map((item) => (
              <Text key={`${item.product_id}:${item.attribute_id}`} style={s.text}>
                {item.quantity} × {item.name} · {money(item.line_amount_minor)}
              </Text>
            ))}
            <Text style={s.text}>
              Livraison : {r.quote.delivery.name ?? "selon devis"} · {money(r.quote.shipping_minor)}
            </Text>
            <Text style={s.title}>Total : {money(r.quote.amount_minor)}</Text>
            {r.status === "pending" && (
              <>
                <Text style={s.muted}>
                  Validation valable jusqu’à {new Date(r.expiresAt).toLocaleTimeString()}. La
                  commande et le paiement demandent deux accords distincts.
                </Text>
                <Button
                  busy={busy}
                  primary
                  onPress={() => void act(`/api/shopping/reviews/${r.id}`, { decision: "approve" })}
                >
                  {r.kind === "create_checkout"
                    ? "Valider la commande fictive"
                    : "Payer ce montant fictif via MPP"}
                </Button>
                <Button
                  busy={busy}
                  danger
                  onPress={() => void act(`/api/shopping/reviews/${r.id}`, { decision: "deny" })}
                >
                  Refuser cette action
                </Button>
              </>
            )}
            {r.authorization && (
              <Button
                onPress={() =>
                  void Linking.openURL(r.authorization ?? "").then(() =>
                    notify(
                      "Autoriser le mandat dans Champollion, puis revenir demander le paiement à l’agent.",
                    ),
                  )
                }
              >
                Ouvrir le consentement Champollion
              </Button>
            )}
            {r.status === "outcome_unknown" && (
              <Text style={s.muted}>
                Réponse non confirmée. Demander à l’agent de relire la commande et le paiement.
                Aucun rejeu automatique.
              </Text>
            )}
            {r.result !== undefined && (
              <Text selectable style={s.muted}>
                {JSON.stringify(r.result, null, 2)}
              </Text>
            )}
            {r.receipt !== undefined && (
              <Text selectable style={s.muted}>
                Reçu MPP : {JSON.stringify(r.receipt)}
              </Text>
            )}
          </View>
        ))}
      </View>
    </Card>
  );
}
