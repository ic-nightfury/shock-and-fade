import { encodeFunctionData } from "viem";

const redeemTx = {
  to: ctfAddress,
  data: encodeFunctionData({
    abi: [{
      name: "redeemPositions",
      type: "function",
      inputs: [
        { name: "collateralToken", type: "address" },
        { name: "parentCollectionId", type: "bytes32" },
        { name: "conditionId", type: "bytes32" },
        { name: "indexSets", type: "uint256[]" }
      ],
      outputs: []
    }],
    functionName: "redeemPositions",
    args: [collateralToken, parentCollectionId, conditionId, indexSets]
  }),
  value: "0"
};

const response = await client.execute([redeemTx], "Redeem positions");
await response.wait();