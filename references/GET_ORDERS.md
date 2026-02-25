async function main() {
  const resp = await clobClient.getOpenOrders({
    market:
      "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af",
  });
  console.log(resp);
  console.log(`Done!`);
}
main();