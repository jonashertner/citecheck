#!/bin/sh
# Downloads of the citecheck manifest per day, from the nginx tier1 log on the
# OpenCaseLaw host (format: addr time "METHOD uri" status time "agent"; rotated
# files included). "unique" = distinct client addresses that day.
#   sh build/nginx/count_downloads.sh
cd /var/log/nginx || exit 1
{ cat tier1.log 2>/dev/null; cat tier1.log.1 2>/dev/null; zcat tier1.log.*.gz 2>/dev/null; } \
  | awk '$3 == "\"GET" && $4 == "/citecheck/manifest.xml\"" && ($5 == 200 || $5 == 304) {
           day = substr($2, 1, 10); n[day]++; u[day SUBSEP $1] = 1 }
         END { for (k in u) { split(k, p, SUBSEP); uu[p[1]]++ }
               for (d in n) printf "%s  %4d downloads  %3d unique\n", d, n[d], uu[d] }' \
  | sort
