import Link from "next/link";
import { notFound } from "next/navigation";

import { loadHbarBalance, loadStream } from "../../../lib/dashboard";
import {
  formatDuration,
  formatHbar,
  formatTimestamp,
  shortenEntityId,
} from "../../../lib/format";
import { responseCodeLabel } from "../../../lib/vesting";

export const dynamic = "force-dynamic";

/** Full-page detail for one stream: every release the network accepted, and why. */
export default async function StreamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!/^\d+$/.test(id)) notFound();

  const stream = await loadStream(BigInt(id));
  if (!stream) notFound();

  const { summary } = stream;
  const symbol = stream.token?.symbol ?? "tokens";
  const balance = await loadHbarBalance(summary.beneficiary);

  return (
    <>
      <header className="masthead">
        <h1>Stream #{summary.scheduleId}</h1>
        <p>
          <Link href="/">← all streams</Link>
        </p>
        <div className="badges">
          <span className="badge">grant token {summary.grantToken}</span>
          <span className="badge">
            {stream.token?.name ?? "unknown token"} · {stream.token?.symbol ?? "?"} ·{" "}
            {stream.token?.decimals ?? "?"} decimals
          </span>
          {summary.revoked ? <span className="badge warn">revoked</span> : null}
        </div>
      </header>

      <section className="panel">
        <h2>Parties</h2>
        <div className="stats">
          <dl className="stat">
            <dt>Beneficiary</dt>
            <dd style={{ fontSize: "0.8rem" }}>{summary.beneficiary}</dd>
          </dl>
          <dl className="stat">
            <dt>Grantor</dt>
            <dd style={{ fontSize: "0.8rem" }}>{summary.grantor}</dd>
          </dl>
          <dl className="stat">
            <dt>Beneficiary HBAR</dt>
            <dd>{balance === null ? "unavailable" : formatHbar(balance, 4)}</dd>
          </dl>
        </div>
        <p className="hint" style={{ marginTop: "0.9rem" }}>
          The beneficiary holds no grant token by construction: the claim path converts and
          unwraps before the transfer lands, so the only balance this contract grows is HBAR.
        </p>
      </section>

      <section className="panel">
        <h2>Schedule</h2>
        <div className="stats">
          <dl className="stat">
            <dt>Total</dt>
            <dd>
              {stream.totalFormatted} {symbol}
            </dd>
          </dl>
          <dl className="stat">
            <dt>Vested</dt>
            <dd>
              {stream.vestedFormatted} {symbol}
            </dd>
          </dl>
          <dl className="stat">
            <dt>Paid</dt>
            <dd>
              {stream.claimedFormatted} {symbol}
            </dd>
          </dl>
          <dl className="stat">
            <dt>Claimable</dt>
            <dd>
              {stream.claimableFormatted} {symbol}
            </dd>
          </dl>
        </div>
        <div className="stats">
          <dl className="stat">
            <dt>Start</dt>
            <dd style={{ fontSize: "0.8rem" }}>{formatTimestamp(summary.startTime)}</dd>
          </dl>
          <dl className="stat">
            <dt>Cliff</dt>
            <dd style={{ fontSize: "0.8rem" }}>{formatTimestamp(summary.cliffTime)}</dd>
          </dl>
          <dl className="stat">
            <dt>End</dt>
            <dd style={{ fontSize: "0.8rem" }}>{formatTimestamp(summary.endTime)}</dd>
          </dl>
          <dl className="stat">
            <dt>Remaining</dt>
            <dd>{formatDuration(summary.secondsRemaining)}</dd>
          </dl>
        </div>
      </section>

      <section className="panel">
        <h2>Releases</h2>
        <p className="hint">
          One HIP-1215 scheduled call per release. The contract asked for the cliff second
          and every interval after it; the Schedule Service accepted{" "}
          {summary.releases.length} of {summary.releaseCount}.
        </p>
        <table>
          <thead>
            <tr>
              <th>Release</th>
              <th>Requested second</th>
              <th>Scheduled second</th>
              <th>Schedule address</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: summary.releaseCount }, (_, index) => {
              const acceptedRelease = summary.releases.find(
                (release) => release.index === index,
              );
              const rejection = summary.rejected.find(
                (release) => release.index === index,
              );
              const requested = summary.cliffTime + index * intervalOf(summary);
              return (
                <tr key={index}>
                  <td className="mono">#{index}</td>
                  <td className="mono">{formatTimestamp(requested)}</td>
                  <td className="mono">
                    {acceptedRelease
                      ? formatTimestamp(acceptedRelease.expirySecond)
                      : "not scheduled"}
                  </td>
                  <td className="mono">
                    {acceptedRelease ? (
                      shortenEntityId(acceptedRelease.scheduleAddress)
                    ) : rejection ? (
                      <span style={{ color: "var(--warn)" }}>
                        {responseCodeLabel(rejection.responseCode)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {summary.rejected.length > 0 ? (
          <p className="hint" style={{ marginTop: "0.9rem" }}>
            A refused release is not a lost release. The contract retries a saturated second
            with exponential backoff, and if it never succeeds the stream still settles
            because <code>executeClaim</code> can be called by anyone at any time and pays
            exactly what has vested.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>Claims</h2>
        {summary.claims.length === 0 ? (
          <p className="hint">
            Nothing has settled yet. The first release lands on the cliff second.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Settled at</th>
                <th>Tokens in</th>
                <th>Vested total</th>
                <th>HBAR out</th>
                <th>Called by</th>
              </tr>
            </thead>
            <tbody>
              {summary.claims.map((claim, index) => (
                <tr key={`${claim.consensusSecond}-${index}`}>
                  <td className="mono">{formatTimestamp(claim.consensusSecond)}</td>
                  <td className="mono">{claim.amountConverted.toString()}</td>
                  <td className="mono">{claim.vestedTotal.toString()}</td>
                  <td className="mono">
                    {(Number(claim.hbarDelivered) / 1e10).toLocaleString("en-US", {
                      maximumFractionDigits: 8,
                    })}{" "}
                    ℏ
                  </td>
                  <td className="mono">{shortenEntityId(claim.caller)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** Seconds between releases, derived from the schedule the contract emitted. */
function intervalOf(summary: { cliffTime: number; endTime: number; releaseCount: number }): number {
  if (summary.releaseCount <= 1) return 0;
  return Math.floor((summary.endTime - summary.cliffTime) / (summary.releaseCount - 1));
}