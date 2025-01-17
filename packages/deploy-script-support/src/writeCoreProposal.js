import fs from 'fs';
import { E } from '@endo/far';

import { createBundles } from '@agoric/internal/src/createBundles.js';
import {
  deeplyFulfilled,
  defangAndTrim,
  mergePermits,
  stringify,
} from './code-gen.js';
import { makeCoreProposalBehavior, permits } from './coreProposalBehavior.js';

export const makeWriteCoreProposal = (
  homeP,
  endowments,
  {
    getBundlerMaker,
    installInPieces,
    log = console.log,
    writeFile = fs.promises.writeFile,
  },
) => {
  const { board, zoe } = E.get(homeP);
  const { bundleSource, pathResolve } = endowments;

  let bundlerCache;
  const getBundler = () => {
    if (!bundlerCache) {
      bundlerCache = E(getBundlerMaker()).makeBundler({
        zoe,
      });
    }
    return bundlerCache;
  };

  const mergeProposalPermit = async (proposal, additionalPermits) => {
    const {
      sourceSpec,
      getManifestCall: [exportedGetManifest, ...manifestArgs],
    } = proposal;

    const manifestNs = await import(pathResolve(sourceSpec));

    // We only care about the manifest, not any restoreRef calls.
    const { manifest } = await manifestNs[exportedGetManifest](
      { restoreRef: x => `restoreRef:${x}` },
      ...manifestArgs,
    );

    const mergedPermits = mergePermits(manifest);
    return {
      manifest,
      permits: mergePermits({ mergedPermits, additionalPermits }),
    };
  };

  let mutex = Promise.resolve();
  const writeCoreProposal = async (filePrefix, proposalBuilder) => {
    // Install an entrypoint.
    const install = async (entrypoint, bundlePath, opts) => {
      const bundler = getBundler();
      let bundle;
      if (bundlePath) {
        const bundleCache = pathResolve(bundlePath);
        await createBundles([[pathResolve(entrypoint), bundleCache]]);
        const ns = await import(bundleCache);
        bundle = ns.default;
      } else {
        bundle = await bundleSource(pathResolve(entrypoint));
      }

      // Serialise the installations.
      mutex = E.when(mutex, () => {
        console.log('installing', { filePrefix, entrypoint, bundlePath });

        return installInPieces(bundle, bundler, opts);
      });
      return mutex;
    };

    // Await a reference then publish to the board.
    const publishRef = async refP => {
      throw Error('writeCoreProposal publishRef not implemented yet');
      // TODO: rewrite to get a BundleID, and then:
      // return harden({ bundleID });
      // eslint-disable-next-line no-unreachable
      const ref = await refP;
      console.log('published', { filePrefix, ref });
      return E(board).getId(ref);
    };

    // Create the proposal structure.
    const proposal = await deeplyFulfilled(
      harden(proposalBuilder({ publishRef, install })),
    );
    const { sourceSpec, getManifestCall } = proposal;
    console.log('created', { filePrefix, sourceSpec, getManifestCall });

    // Extract the top-level permit.
    const { permits: proposalPermit, manifest: overrideManifest } =
      await mergeProposalPermit(proposal, permits);

    // Get an install
    // TODO: this won't use install(), because it won't go through zoe
    const manifestBundleRef = await publishRef(install(sourceSpec));
    console.log('writing', { filePrefix, manifestBundleRef, sourceSpec });
    const code = `\
// This is generated by writeCoreProposal; please edit!
/* eslint-disable */

const manifestBundleRef = ${stringify(manifestBundleRef)};
const getManifestCall = harden(${stringify(getManifestCall, true)});
const overrideManifest = ${stringify(overrideManifest, true)};

// Make the behavior the completion value.
(${makeCoreProposalBehavior})({ manifestBundleRef, getManifestCall, overrideManifest, E });
`;

    const trimmed = defangAndTrim(code);

    const proposalPermitJsonFile = `${filePrefix}-permit.json`;
    log(`creating ${proposalPermitJsonFile}`);
    await writeFile(
      proposalPermitJsonFile,
      JSON.stringify(proposalPermit, null, 2),
    );

    const proposalJsFile = `${filePrefix}.js`;
    log(`creating ${proposalJsFile}`);
    await writeFile(proposalJsFile, trimmed);

    log(`\
You can now run a governance submission command like:
  agd tx gov submit-proposal swingset-core-eval ${proposalPermitJsonFile} ${proposalJsFile} \\
    --title="Enable <something>" --description="Evaluate ${proposalJsFile}" --deposit=1000000ubld \\
    --gas=auto --gas-adjustment=1.2
`);
  };

  return writeCoreProposal;
};
