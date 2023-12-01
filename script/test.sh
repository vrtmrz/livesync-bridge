#!/bin/bash
today=`date "+%Y/%m/%d %H:%M:%S"`
echo "${today} $1 $2" >> `dirname -- "$( readlink -f -- "$0"; )";`/test.log