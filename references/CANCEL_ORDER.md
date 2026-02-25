async function main() {
  // Send it to the server
  const resp = await clobClient.cancelMarketOrders({
    market:
      "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
    asset_id:
      "52114319501245915516055106046884209969926127482827954674443846427813813222426",
  });
  console.log(resp);
  console.log(`Done!`);
}
main();