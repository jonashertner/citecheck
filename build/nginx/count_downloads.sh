#!/bin/sh
# Downloads of the citecheck manifest per day, from the nginx tier1 log on the
# OpenCaseLaw host (format: addr time "METHOD uri" status time "agent").
# "unique" = distinct client addresses that day.
#
#   sh build/nginx/count_downloads.sh                 # print every day in the logs
#   sh build/nginx/count_downloads.sh --record FILE   # append complete days to FILE
#
# The host keeps about four days of tier1 logs, so --record runs daily (see
# build/systemd/citecheck-downloads.*). It appends every complete UTC day the
# logs cover and FILE does not hold yet, zero-download days included, so a day
# missing from FILE means "not measured", never "no downloads". Today is left
# out (not complete), and so is the oldest day in the logs (rotation may have
# removed its first hours). Days before $CITECHECK_SINCE (2026-09-24, when the
# counted download link went live) are ignored: the host still holds tier1
# files from April.
#
# Addresses listed in $CITECHECK_EXCLUDE (default /etc/citecheck/exclude-addrs,
# one per line, # comments) are not counted: our own test downloads. That file
# lives on the host, not in this repository.
LOG_DIR=${CITECHECK_LOG_DIR:-/var/log/nginx}
EXCLUDE=${CITECHECK_EXCLUDE:-/etc/citecheck/exclude-addrs}
TODAY=${CITECHECK_TODAY:-$(date -u +%F)}
SINCE=${CITECHECK_SINCE:-2026-09-24}

RECORD=
if [ "$1" = "--record" ]; then
    RECORD=$2
    [ -n "$RECORD" ] || { echo "usage: $0 [--record FILE]" >&2; exit 2; }
fi

cd "$LOG_DIR" || exit 1

# Every tier1 file, plain or gzipped, whatever logrotate named it
# (tier1.log.1, tier1.log.2.gz, tier1.log-20260926-00, tier1.log-...-00.gz).
dump() {
    for f in tier1.log*; do
        [ -f "$f" ] || continue
        case $f in
            *.gz) gzip -dc "$f" || return 1 ;;
            *) cat "$f" || return 1 ;;
        esac
    done
}

count() {
    dump | awk -v today="$TODAY" -v record="$RECORD" -v excl="$EXCLUDE" -v since="$SINCE" '
        BEGIN {
            while ((getline line < excl) > 0) {
                sub(/#.*/, "", line); split(line, w, " ")
                if (w[1] != "") skip[w[1]] = 1
            }
            if (record != "")
                while ((getline line < record) > 0) {
                    split(line, w, "\t")
                    if (w[1] ~ /^[0-9][0-9][0-9][0-9]-/) have[w[1]] = 1
                }
        }
        {
            day = substr($2, 1, 10)
            if (day !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) next
            if (first == "" || day < first) first = day
            if (day < since) next
            seen[day] = 1
            if ($3 == "\"GET" && $4 ~ /^\/citecheck\/manifest\.xml(\?[^"]*)?"$/ \
                && ($5 == 200 || $5 == 304) && !($1 in skip)) {
                n[day]++
                if (!((day, $1) in u)) { u[day, $1] = 1; uu[day]++ }
            }
        }
        END {
            for (d in seen) {
                if (record == "")
                    printf "%s  %4d downloads  %3d unique\n", d, n[d], uu[d]
                else if (d < today && d != first && !(d in have))
                    printf "%s\t%d\t%d\n", d, n[d], uu[d]
            }
        }' | sort
}

if [ -z "$RECORD" ]; then
    count
    exit
fi

tmp=$(mktemp) || exit 1
trap 'rm -f "$tmp"' EXIT
count > "$tmp" || exit 1
if [ ! -s "$RECORD" ]; then
    printf "day\tdownloads\tunique\n" > "$RECORD" || exit 1
fi
cat "$tmp" >> "$RECORD"
